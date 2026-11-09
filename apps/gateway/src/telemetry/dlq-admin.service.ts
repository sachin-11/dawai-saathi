import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

import { AuditService } from '../audit/audit.service';
import { RedisService } from '../common/redis/redis.service';
import { DLQ_SOURCE_QUEUES, DlqService, type DlqEntry, type DlqSourceQueue } from './dlq.service';

export interface DlqListing {
  queue: DlqSourceQueue;
  size: number;
  entries: (DlqEntry & { dlqJobId: string })[];
}

export function assertSourceQueue(name: string): DlqSourceQueue {
  if ((DLQ_SOURCE_QUEUES as readonly string[]).includes(name)) return name as DlqSourceQueue;
  throw new Error(`unknown queue "${name}" (expected one of ${DLQ_SOURCE_QUEUES.join(', ')})`);
}

/** Operator actions on dead letters (M15). Only the CLI uses it; every change is audited. */
@Injectable()
export class DlqAdminService implements OnModuleDestroy {
  private readonly sources = new Map<string, Queue>();

  constructor(
    private readonly dlq: DlqService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  private source(queue: DlqSourceQueue): Queue {
    let existing = this.sources.get(queue);
    if (!existing) {
      existing = new Queue(queue, {
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      existing.on('error', () => undefined);
      this.sources.set(queue, existing);
    }
    return existing;
  }

  async list(queue: DlqSourceQueue, limit = 50): Promise<DlqListing> {
    const dead = this.dlq.queue(queue);
    const jobs = await dead.getJobs(['waiting', 'completed', 'delayed', 'active'], 0, limit - 1);
    const counts = await dead.getJobCounts('waiting', 'completed', 'delayed', 'active');
    return {
      queue,
      size: Object.values(counts).reduce((sum, n) => sum + n, 0),
      entries: jobs.map((job) => ({ ...(job.data as DlqEntry), dlqJobId: String(job.id) })),
    };
  }

  /**
   * Put the original failed jobs back into their queue (from the failed set, where the payload still
   * is) and remove their dead letters. `jobId` limits it to one source job.
   */
  async retry(
    queue: DlqSourceQueue,
    options: { jobId?: string } = {},
  ): Promise<{ retried: number; missing: number }> {
    const dead = this.dlq.queue(queue);
    const jobs = await dead.getJobs(['waiting', 'completed', 'delayed', 'active'], 0, 999);
    let retried = 0;
    let missing = 0;
    for (const entryJob of jobs) {
      const entry = entryJob.data as DlqEntry;
      if (options.jobId && entry.sourceJobId !== options.jobId) continue;
      const original = await this.source(queue).getJob(entry.sourceJobId);
      if (original && (await original.isFailed())) {
        await original.retry('failed');
        retried += 1;
      } else {
        missing += 1;
      }
      await entryJob.remove().catch(() => undefined);
    }
    await this.audit.log({
      actor: 'admin',
      userId: null,
      action: 'dlq_retry',
      metadata: { queue, retried, missing },
    });
    return { retried, missing };
  }

  /** Delete dead letters (the failed originals stay in their own retention). */
  async purge(queue: DlqSourceQueue): Promise<{ purged: number }> {
    const dead = this.dlq.queue(queue);
    const counts = await dead.getJobCounts('waiting', 'completed', 'delayed', 'active');
    const purged = Object.values(counts).reduce((sum, n) => sum + n, 0);
    await dead.obliterate({ force: true });
    await this.audit.log({
      actor: 'admin',
      userId: null,
      action: 'dlq_purge',
      metadata: { queue, purged },
    });
    return { purged };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.sources.values()].map((queue) => queue.close().catch(() => undefined)),
    );
  }
}
