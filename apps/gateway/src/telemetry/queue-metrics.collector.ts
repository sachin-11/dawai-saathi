import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { DLQ_SOURCE_QUEUES, dlqName } from './dlq.service';
import { MetricsService } from './metrics.service';

export const QUEUE_SAMPLE_INTERVAL_MS = 10_000;

/** Samples `queue_depth{queue}` and `dlq_size{queue}` every 10 s (gauges cannot be updated inline). */
@Injectable()
export class QueueMetricsCollector implements OnModuleInit, OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly env: Pick<Env, 'NODE_ENV'>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueueMetricsCollector.name);
  }

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return; // unit/e2e tests must not open Redis connections
    this.timer = setInterval(() => void this.sample(), QUEUE_SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      queue.on('error', () => undefined);
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Readiness: BullMQ can talk to Redis (a real queue command, not just PING). */
  async ping(): Promise<void> {
    await this.queue('inbound').getJobCounts('waiting');
  }

  async sample(): Promise<void> {
    for (const name of DLQ_SOURCE_QUEUES) {
      try {
        const counts = await this.queue(name).getJobCounts('waiting', 'prioritized');
        this.metrics.queueDepth.set(
          { queue: name },
          (counts['waiting'] ?? 0) + (counts['prioritized'] ?? 0),
        );
        const dead = await this.queue(dlqName(name)).getJobCounts(
          'waiting',
          'completed',
          'delayed',
        );
        this.metrics.dlqSize.set(
          { queue: name },
          (dead['waiting'] ?? 0) + (dead['completed'] ?? 0) + (dead['delayed'] ?? 0),
        );
      } catch (error) {
        this.logger.warn({ queue: name, error: (error as Error).name }, 'queue sample failed');
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(
      [...this.queues.values()].map((queue) => queue.close().catch(() => undefined)),
    );
  }
}
