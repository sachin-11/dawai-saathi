import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { withTimeout } from '../common/timeout/with-timeout';
import type { OutboundJobData } from './outbound.types';

export const OUTBOUND_QUEUE = 'outbound';
export const OUTBOUND_ENQUEUE_TIMEOUT_MS = 2000;
export const OUTBOUND_ATTEMPTS = 5;

export const OUTBOUND_JOB_OPTIONS: JobsOptions = {
  attempts: OUTBOUND_ATTEMPTS,
  // Delay is computed by the worker's backoffStrategy (longer for rate limits).
  backoff: { type: 'custom' },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

/**
 * Deterministic job id: the same reply to the same inbound message maps to the same job, so a
 * retried inbound job can enqueue its reply again without the user getting it twice.
 * (BullMQ forbids ":" in custom ids, hence "_".)
 */
export function outboundJobId(sourceMessageId: string, replyIndex: number): string {
  return `${sourceMessageId}_${replyIndex}`.replaceAll(':', '_');
}

/** Producer side of the `outbound` queue (all WhatsApp sends go through it). */
@Injectable()
export class OutboundQueue implements OnModuleDestroy {
  private queue: Queue<OutboundJobData> | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboundQueue.name);
  }

  async add(data: OutboundJobData, options: { priority?: number } = {}): Promise<void> {
    const queue = this.getQueue();
    await withTimeout(
      () =>
        queue.add('send', data, {
          ...OUTBOUND_JOB_OPTIONS,
          ...(options.priority !== undefined ? { priority: options.priority } : {}),
          jobId: outboundJobId(data.sourceMessageId, data.replyIndex),
        }),
      OUTBOUND_ENQUEUE_TIMEOUT_MS,
    );
  }

  getQueue(): Queue<OutboundJobData> {
    if (!this.queue) {
      this.queue = new Queue<OutboundJobData>(OUTBOUND_QUEUE, {
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      this.queue.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.warn(`outbound queue error: ${error.code ?? error.name}`);
      });
    }
    return this.queue;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.queue?.close();
    } catch {
      // Redis may already be gone during shutdown.
    }
  }
}
