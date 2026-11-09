import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Job, Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { WorkerFactory } from '../telemetry/worker-factory.service';
import {
  USER_DELETION_ATTEMPTS,
  USER_DELETION_QUEUE,
  type UserDeletionJobData,
} from './user-deletion.queue';
import { UserDeletionService } from './user-deletion.service';

/** Consumer of the `user-deletion` queue. */
@Injectable()
export class UserDeletionWorker implements OnModuleInit, OnModuleDestroy {
  private worker: Worker<UserDeletionJobData> | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly deletion: UserDeletionService,
    private readonly workers: WorkerFactory,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(UserDeletionWorker.name);
  }

  onModuleInit(): void {
    if (!this.env.WORKERS_ENABLED) {
      return;
    }
    this.worker = this.workers.create<UserDeletionJobData>(
      USER_DELETION_QUEUE,
      async (job) => {
        await this.deletion.execute(job);
      },
      { connection: this.redis.createConnection({ maxRetriesPerRequest: null }), concurrency: 2 },
    );
    this.worker.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.warn(`user-deletion worker error: ${error.code ?? error.name}`);
    });
    this.worker.on('failed', (job: Job<UserDeletionJobData> | undefined, error: Error) => {
      const exhausted = (job?.attemptsMade ?? 0) >= USER_DELETION_ATTEMPTS;
      // An exhausted erasure is a compliance problem: this log is what an alert (M15) will key on.
      this.logger[exhausted ? 'error' : 'warn'](
        { job_id: job?.id, attempts_made: job?.attemptsMade, error: error.name },
        exhausted
          ? 'USER ERASURE FAILED PERMANENTLY: manual action needed'
          : 'user erasure failed, will retry',
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.workers.close(this.worker);
  }
}
