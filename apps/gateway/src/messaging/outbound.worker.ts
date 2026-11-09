import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Job, UnrecoverableError, type Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { CryptoError } from '../common/crypto/crypto.util';
import { InvalidPhoneError } from '../common/crypto/phone';
import { RedisService } from '../common/redis/redis.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { MetricsService } from '../telemetry/metrics.service';
import { WorkerFactory } from '../telemetry/worker-factory.service';
import { OUTBOUND_QUEUE } from './outbound.queue';
import type { OutboundJobData } from './outbound.types';
import { OutboundService } from './outbound.service';
import { WhatsAppApiError, WhatsAppValidationError } from './whatsapp.errors';

/**
 * Delay before retry number `attemptsMade`. Rate limits get a much longer wait (Meta's pair rate
 * limit alone is one message per ~6 s per user); everything else backs off exponentially with jitter.
 */
export function outboundBackoffMs(
  attemptsMade: number,
  error: Error | undefined,
  random: () => number = Math.random,
): number {
  if (error instanceof WhatsAppApiError && error.kind === 'rate_limit') {
    return Math.min(300_000, 30_000 * attemptsMade);
  }
  const exponential = Math.min(60_000, 2_000 * 2 ** (attemptsMade - 1));
  return Math.round(exponential / 2 + (random() * exponential) / 2);
}

/** Errors that no retry can fix: fail the job now instead of burning all attempts. */
export function toUnrecoverable(error: unknown): Error {
  if (error instanceof UnrecoverableError) {
    return error;
  }
  if (error instanceof WhatsAppApiError && !error.retryable) {
    // Controlled message: only the error kind and Meta's code, never user data.
    return new UnrecoverableError(`whatsapp ${error.kind} error (code ${error.code ?? 'n/a'})`);
  }
  if (
    error instanceof WhatsAppValidationError ||
    error instanceof CryptoError ||
    error instanceof InvalidPhoneError
  ) {
    return new UnrecoverableError(error.message);
  }
  return error instanceof Error ? error : new Error('unknown error');
}

/** Consumer of the `outbound` queue: the only place that actually calls the WhatsApp send API. */
@Injectable()
export class OutboundWorker implements OnModuleInit, OnModuleDestroy {
  private worker: Worker<OutboundJobData> | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly outbound: OutboundService,
    private readonly workers: WorkerFactory,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboundWorker.name);
  }

  onModuleInit(): void {
    if (!this.env.WORKERS_ENABLED) {
      return;
    }
    this.worker = this.workers.create<OutboundJobData>(
      OUTBOUND_QUEUE,
      async (job) => {
        const emergency = job.opts.priority === 1;
        try {
          const { kind } = await this.outbound.deliver(job);
          this.metrics.waOutbound.inc({ kind, status: 'sent' });
          if (emergency) this.metrics.emergencyOutbound.inc({ status: 'sent' });
          const latency = job.data.latency;
          if (latency) {
            const ms = Date.now() - new Date(latency.receivedAt).getTime();
            if (Number.isFinite(ms) && ms >= 0) {
              this.metrics.replyLatency.observe({ intent: latency.intent }, ms);
            }
          }
        } catch (error) {
          const failure = toUnrecoverable(error);
          if (error instanceof WhatsAppApiError) {
            this.metrics.waApiErrors.inc({ code: String(error.code ?? 'none') });
          }
          this.metrics.waOutbound.inc({ kind: 'unknown', status: 'failed' });
          if (emergency) this.metrics.emergencyOutbound.inc({ status: 'failed' });
          throw failure;
        }
      },
      {
        connection: this.redis.createConnection({ maxRetriesPerRequest: null }),
        concurrency: 5,
        // Throughput cap (Meta allows 80 msg/s per number by default).
        limiter: { max: this.env.OUTBOUND_RATE_PER_SEC, duration: 1000 },
        settings: {
          backoffStrategy: (attemptsMade: number, _type?: string, error?: Error): number =>
            outboundBackoffMs(attemptsMade, error),
        },
      },
    );
    this.worker.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.warn(`outbound worker error: ${error.code ?? error.name}`);
    });
    this.worker.on('failed', (job: Job<OutboundJobData> | undefined, error: Error) => {
      const permanent = error instanceof UnrecoverableError || (job?.attemptsMade ?? 0) >= 5;
      this.logger[permanent ? 'error' : 'warn'](
        { job_id: job?.id, attempts_made: job?.attemptsMade, reason: error.message },
        permanent ? 'outbound job failed permanently' : 'outbound job failed, will retry',
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.workers.close(this.worker);
  }
}
