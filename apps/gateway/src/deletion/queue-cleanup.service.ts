import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';

/** The queues that may hold jobs referencing a user. `reminders` joins in M10. */
export const USER_JOB_QUEUES: readonly string[] = ['inbound', 'outbound'];

/** Every state in which a job can be removed. Active jobs are locked by a worker and cannot be. */
const REMOVABLE_STATES = [
  'waiting',
  'delayed',
  'prioritized',
  'paused',
  'waiting-children',
  'completed',
  'failed',
] as const;

const PAGE_SIZE = 200;

export interface JobLike {
  data: { userId?: unknown };
  remove(): Promise<void>;
}

export interface QueueLike {
  getJobs(types: readonly string[], start: number, end: number): Promise<JobLike[]>;
}

/**
 * Remove every job of `userId` from one queue and return how many were removed.
 *
 * BullMQ cannot query jobs by their data, so this pages through the queue and filters. That is O(n)
 * in the queue size, fine for the retained history (last 1000 completed jobs) plus a short backlog.
 * Matching jobs are collected first and removed afterwards, because removing while paging would
 * shift the page boundaries. Completed outbound jobs matter: they hold the (encrypted) reply text.
 * A job that is locked or already gone is skipped.
 */
export async function removeJobsForUser(queue: QueueLike, userId: string): Promise<number> {
  const matching: JobLike[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const page = await queue.getJobs(REMOVABLE_STATES, start, start + PAGE_SIZE - 1);
    matching.push(...page.filter((job) => job.data.userId === userId));
    if (page.length < PAGE_SIZE) break;
  }

  let removed = 0;
  for (const job of matching) {
    try {
      await job.remove();
      removed += 1;
    } catch {
      // Locked by a worker or already removed: nothing to do.
    }
  }
  return removed;
}

/** Opens its own lightweight queue handles, so it needs no dependency on the producer modules. */
@Injectable()
export class QueueCleanupService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueueCleanupService.name);
  }

  /** Remove the user's jobs from every user-bearing queue. Returns the total removed. */
  async removeAllFor(userId: string): Promise<number> {
    let total = 0;
    for (const name of USER_JOB_QUEUES) {
      total += await removeJobsForUser(this.queue(name) as unknown as QueueLike, userId);
    }
    return total;
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      queue.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.warn(`cleanup queue error: ${error.code ?? error.name}`);
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.queues.values()].map(async (queue) => {
        try {
          await queue.close();
        } catch {
          // Redis may already be gone during shutdown.
        }
      }),
    );
    this.queues.clear();
  }
}
