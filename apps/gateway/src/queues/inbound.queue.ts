import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { withTimeout } from '../common/timeout/with-timeout';
import { INBOUND_QUEUE, type InboundJobData } from './queue.constants';

/** If Redis does not answer in time, fail the webhook (HTTP 500) so Meta retries later. */
export const ENQUEUE_TIMEOUT_MS = 2000;

export const INBOUND_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000 },
  // Failed jobs are kept for inspection / the dead-letter flow (M15).
  removeOnFail: false,
};

/** Producer side of the `inbound` queue. The BullMQ Queue is created lazily on first use. */
@Injectable()
export class InboundQueue implements OnModuleDestroy {
  private queue: Queue<InboundJobData> | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InboundQueue.name);
  }

  /**
   * Enqueue one job. `jobId = waMessageId`, so adding the same WhatsApp message twice (Meta retry,
   * or a retry after a half-failed webhook call) is a no-op: the second idempotency layer.
   */
  async add(data: InboundJobData): Promise<void> {
    const queue = this.getQueue();
    await withTimeout(
      () =>
        queue.add(data.type, data, {
          ...INBOUND_JOB_OPTIONS,
          // BullMQ forbids ':' in custom ids; real wamid values never contain it, but be safe.
          jobId: data.waMessageId.replaceAll(':', '_'),
        }),
      ENQUEUE_TIMEOUT_MS,
    );
  }

  /** Exposed for tests and the future admin/DLQ views. */
  getQueue(): Queue<InboundJobData> {
    if (!this.queue) {
      this.queue = new Queue<InboundJobData>(INBOUND_QUEUE, {
        // Own connection, owned (and closed) by RedisService. Fail fast instead of retrying forever.
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      this.queue.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.warn(`inbound queue error: ${error.code ?? error.name}`);
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
