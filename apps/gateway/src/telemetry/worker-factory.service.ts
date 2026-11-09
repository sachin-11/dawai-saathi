import { Inject, Injectable } from '@nestjs/common';
import { SpanKind } from '@opentelemetry/api';
import { type Job, type Processor, Worker, type WorkerOptions } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { DLQ_SOURCE_QUEUES, DlqService, type DlqSourceQueue, errorCodeOf } from './dlq.service';
import { MetricsService } from './metrics.service';
import { contextFromCarrier, inSpan, type TraceCarrier } from './trace-context';

/** Failure reasons are a small fixed set (a metric label). */
export function failureReason(error: Error): string {
  if (error.name === 'UnrecoverableError') return 'unrecoverable';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
  if (/^(Prisma|PrismaClient)/.test(error.name)) return 'database';
  if (error.name === 'AiServiceError') return 'ai_service';
  if (error.name === 'WhatsAppApiError') return 'whatsapp';
  return 'error';
}

/** After the grace period, how long a forced close may still take before shutdown moves on. */
export const FORCE_CLOSE_CAP_MS = 2000;

const isDlqQueue = (name: string): name is DlqSourceQueue =>
  (DLQ_SOURCE_QUEUES as readonly string[]).includes(name);

/**
 * The one place that creates BullMQ workers (M15). Every worker made here
 *   - continues the trace stored in the job (`_tp`) and measures queue wait and duration,
 *   - counts failures by reason and moves a job that ran out of attempts to `<queue>-dlq`,
 *   - is closed gracefully: it stops taking jobs, gets SHUTDOWN_GRACE_S to finish the ones in flight,
 *     and is then closed forcibly (the unfinished jobs are retried by another worker).
 */
@Injectable()
export class WorkerFactory {
  /** In-flight job promises per worker: lets `close` wait for them with a deadline. */
  private readonly workers = new Map<Worker, Set<Promise<unknown>>>();

  constructor(
    private readonly metrics: MetricsService,
    private readonly dlq: DlqService,
    @Inject(APP_CONFIG) private readonly env: Pick<Env, 'SHUTDOWN_GRACE_S'>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerFactory.name);
  }

  create<T extends object>(
    queueName: string,
    processor: Processor<T & TraceCarrier>,
    options: WorkerOptions,
  ): Worker<T & TraceCarrier> {
    const inFlight = new Set<Promise<unknown>>();
    const worker = new Worker<T & TraceCarrier>(
      queueName,
      (job, token) => {
        const running = this.instrument(queueName, job, token, processor);
        inFlight.add(running);
        const done = (): void => void inFlight.delete(running);
        running.then(done, done);
        return running;
      },
      options,
    );
    worker.on('failed', (job, error) => {
      this.onFailed(queueName, job, error);
    });
    this.workers.set(worker, inFlight);
    return worker;
  }

  private async instrument<T extends object>(
    queueName: string,
    job: Job<T & TraceCarrier>,
    token: string | undefined,
    processor: Processor<T & TraceCarrier>,
  ): Promise<unknown> {
    const startedAt = Date.now();
    // Delayed jobs (reminders) wait on purpose: only the time AFTER they were due counts.
    const dueAt = job.timestamp + (job.opts.delay ?? 0);
    this.metrics.queueWait.observe({ queue: queueName }, Math.max(0, startedAt - dueAt));
    try {
      return await inSpan(
        {
          name: `${queueName} process`,
          kind: SpanKind.CONSUMER,
          parent: contextFromCarrier(job.data),
          attributes: {
            queue: queueName,
            job_id: job.id ?? '',
            attempt: job.attemptsMade + 1,
          },
        },
        () => Promise.resolve(processor(job, token)),
      );
    } finally {
      this.metrics.jobDuration.observe({ queue: queueName }, Date.now() - startedAt);
    }
  }

  private onFailed(queueName: string, job: Job | undefined, error: Error): void {
    this.metrics.jobFailed.inc({ queue: queueName, reason: failureReason(error) });
    if (!job || !isDlqQueue(queueName) || !DlqService.isFinalFailure(job, error)) return;
    void this.dlq.moveToDlq(queueName, job, error).catch((dlqError: unknown) => {
      this.logger.error(
        { queue: queueName, error: dlqError instanceof Error ? errorCodeOf(dlqError) : 'unknown' },
        'dead-letter move failed',
      );
    });
  }

  /** Graceful close of one worker (used by each worker's `onModuleDestroy`). */
  async close(worker: Worker | undefined): Promise<void> {
    if (!worker) return;
    const inFlight = this.workers.get(worker) ?? new Set<Promise<unknown>>();
    this.workers.delete(worker);
    const graceMs = this.env.SHUTDOWN_GRACE_S * 1000;
    let timer: NodeJS.Timeout | undefined;
    try {
      // 1. stop taking new jobs right away (do not wait for the active ones here)
      await worker.pause(true);
      // 2. give the jobs in flight SHUTDOWN_GRACE_S to finish
      const settled = Promise.allSettled([...inFlight]).then(() => 'drained' as const);
      const outcome = await Promise.race([
        settled,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout');
          }, graceMs);
          timer.unref();
        }),
      ]);
      if (outcome === 'timeout') {
        this.logger.warn(
          { queue: worker.name, grace_s: this.env.SHUTDOWN_GRACE_S, unfinished: inFlight.size },
          'worker did not finish in time, closing it forcibly (the jobs will be retried)',
        );
      }
      // 3. close. A forced close must never hang shutdown: after FORCE_CLOSE_CAP_MS we stop waiting (the
      // unfinished job's lock expires and another worker retries it; the process exits anyway).
      if (outcome === 'timeout') {
        await Promise.race([
          worker.close(true),
          new Promise<void>((resolve) => {
            const cap = setTimeout(resolve, FORCE_CLOSE_CAP_MS);
            cap.unref();
          }),
        ]);
      } else {
        await worker.close();
      }
    } catch {
      // Redis may already be gone during shutdown.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
