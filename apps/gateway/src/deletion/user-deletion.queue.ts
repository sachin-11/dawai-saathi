import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { withTimeout } from '../common/timeout/with-timeout';
import type { UserLanguage } from '../users/users.service';

export const USER_DELETION_QUEUE = 'user-deletion';
const ENQUEUE_TIMEOUT_MS = 2000;
export const USER_DELETION_ATTEMPTS = 5;

/**
 * Payload of a `user-deletion` job. The number is kept ENCRYPTED (AES-256-GCM): it is needed only
 * for the final "everything is deleted" message, which must be sent AFTER the user row (and its
 * `wa_phone_enc`) is gone. A retry after a crash would otherwise have no number left.
 */
export interface UserDeletionJobData {
  userId: string;
  /** Encrypted phone number (v1:iv:tag:ct). Null if it could not be read; then no final message. */
  waPhoneEnc: string | null;
  language: UserLanguage;
  requestId: string;
  /** Set right after the final message was sent, so a retry does not send it twice. */
  finalMessageSent?: boolean;
  /** Progress carried across retries so the anonymous audit row reports the real totals. */
  s3ObjectsDeleted?: number;
  queueJobsRemoved?: number;
}

export const USER_DELETION_JOB_OPTIONS: JobsOptions = {
  attempts: USER_DELETION_ATTEMPTS,
  backoff: { type: 'exponential', delay: 5_000 },
  // Do not leave the encrypted phone number in Redis: remove the job as soon as it succeeds, and
  // keep a failed one for one hour only.
  removeOnComplete: true,
  removeOnFail: { age: 3600 },
};

/** `:` is not allowed in BullMQ custom ids, so the id is `delete_<userId>`. */
export function userDeletionJobId(userId: string): string {
  return `delete_${userId}`;
}

@Injectable()
export class UserDeletionQueue implements OnModuleDestroy {
  private queue: Queue<UserDeletionJobData> | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(UserDeletionQueue.name);
  }

  /** Idempotent: one erasure job per user id. */
  async add(data: UserDeletionJobData): Promise<void> {
    const queue = this.getQueue();
    await withTimeout(
      () =>
        queue.add('delete-user', data, {
          ...USER_DELETION_JOB_OPTIONS,
          jobId: userDeletionJobId(data.userId),
        }),
      ENQUEUE_TIMEOUT_MS,
    );
  }

  getQueue(): Queue<UserDeletionJobData> {
    if (!this.queue) {
      this.queue = new Queue<UserDeletionJobData>(USER_DELETION_QUEUE, {
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      this.queue.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.warn(`user-deletion queue error: ${error.code ?? error.name}`);
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
