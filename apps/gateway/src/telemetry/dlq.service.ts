import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { MetricsService } from './metrics.service';
import type { TraceCarrier } from './trace-context';

/** The queues that get a dead-letter queue (M15). Their DLQ is named `<queue>-dlq`. */
export const DLQ_SOURCE_QUEUES = ['inbound', 'outbound', 'reminders', 'user-deletion'] as const;
export type DlqSourceQueue = (typeof DLQ_SOURCE_QUEUES)[number];

export const dlqName = (queue: string): string => `${queue}-dlq`;

/**
 * What a dead-letter entry holds: where it came from and why it died. NO payload (it could hold
 * encrypted PHI): the original job stays in its queue's failed set, and the operator CLI retries it
 * from there. Ids are uuids; `errorCode` is an error class name or a Meta code, never a message.
 */
export interface DlqEntry {
  sourceQueue: DlqSourceQueue;
  sourceJobId: string;
  jobName: string;
  attemptsMade: number;
  errorCode: string;
  traceId: string | null;
  userId: string | null;
  messageId: string | null;
  failedAt: string;
}

/** A side effect for one queue's dead letters (e.g. "tell the user to try again"). */
export type DlqHandler = (entry: DlqEntry, job: Job) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/** The trace id inside a `traceparent` (`00-<trace>-<span>-<flags>`), or null. */
export function traceIdOf(data: TraceCarrier | undefined): string | null {
  const parts = data?._tp?.split('-');
  return parts && parts.length === 4 && /^[0-9a-f]{32}$/.test(parts[1] ?? '')
    ? (parts[1] as string)
    : null;
}

export function errorCodeOf(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : error.name;
}

/** Moves exhausted jobs into `<queue>-dlq`, counts them and runs the registered side effects. */
@Injectable()
export class DlqService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();
  private readonly handlers = new Map<string, DlqHandler[]>();

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DlqService.name);
  }

  register(queue: DlqSourceQueue, handler: DlqHandler): void {
    this.handlers.set(queue, [...(this.handlers.get(queue) ?? []), handler]);
  }

  /** The DLQ for a source queue (created on first use). */
  queue(source: string): Queue {
    const name = dlqName(source);
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      queue.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.warn(`${name} error: ${error.code ?? error.name}`);
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** True when this failure was the last one BullMQ will make for the job. */
  static isFinalFailure(job: Job, error: Error): boolean {
    return error.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
  }

  async moveToDlq(source: DlqSourceQueue, job: Job, error: Error): Promise<DlqEntry | undefined> {
    const data = (job.data ?? {}) as TraceCarrier & { userId?: unknown; messageId?: unknown };
    const entry: DlqEntry = {
      sourceQueue: source,
      sourceJobId: job.id ?? '',
      jobName: job.name,
      attemptsMade: job.attemptsMade,
      errorCode: errorCodeOf(error),
      traceId: traceIdOf(data),
      userId: safeId(data.userId),
      messageId: safeId(data.messageId),
      failedAt: new Date().toISOString(),
    };
    try {
      await this.queue(source).add('dead', entry, {
        // One entry per source job: a second 'failed' event for the same job is a no-op.
        jobId: `dlq_${source}_${entry.sourceJobId}`.replaceAll(':', '_'),
        removeOnComplete: false,
        removeOnFail: false,
      });
      this.metrics.dlqMoved.inc({ queue: source });
    } catch (dlqError) {
      this.logger.error(
        { queue: source, job_id: entry.sourceJobId, error: (dlqError as Error).name },
        'could not write to the dead-letter queue',
      );
      return undefined;
    }
    // The line an alert can key on; ids and codes only.
    this.logger.error(
      {
        event: 'job_dead_lettered',
        queue: source,
        job_id: entry.sourceJobId,
        attempts_made: entry.attemptsMade,
        error_code: entry.errorCode,
        user_id: entry.userId,
        trace_id: entry.traceId,
      },
      'job moved to the dead-letter queue',
    );
    for (const handler of this.handlers.get(source) ?? []) {
      try {
        await handler(entry, job);
      } catch (handlerError) {
        this.logger.error(
          { queue: source, error: (handlerError as Error).name },
          'dead-letter handler failed',
        );
      }
    }
    return entry;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.queues.values()].map((queue) => queue.close().catch(() => undefined)),
    );
  }
}
