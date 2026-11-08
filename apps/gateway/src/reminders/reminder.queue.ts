import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { withTimeout } from '../common/timeout/with-timeout';
import { epochSeconds } from './clock';

export const REMINDERS_QUEUE = 'reminders';
const ENQUEUE_TIMEOUT_MS = 2000;

/**
 * Every job carries `userId` (except the two repeatable schedulers), so the DELETE flow can find and
 * remove a user's jobs with the generic `removeJobsForUser` helper. Jobs hold ids and ISO times only:
 * no phone number, no medicine name, no text.
 */
export interface SlotJobData {
  userId: string;
  /** ISO time of the slot. */
  scheduledAt: string;
}
export interface SnoozeJobData extends SlotJobData {
  attempt: number;
}
export interface CaregiverReplyJobData {
  /** Owner of the caregiver row (the patient). */
  userId: string;
  caregiverId: string;
  reply: 'yes' | 'no' | 'stop_alerts';
  waMessageId: string;
}
export type ReminderJobData =
  SlotJobData | SnoozeJobData | CaregiverReplyJobData | Record<string, never>;

export const JOB = {
  slot: 'slot',
  missed: 'missed',
  snooze: 'snooze',
  alert: 'alert',
  caregiverReply: 'caregiver_reply',
  planner: 'planner',
  caregiverExpiry: 'caregiver_expiry',
} as const;
export type ReminderJobName = (typeof JOB)[keyof typeof JOB];

export const PLANNER_EVERY_MS = 15 * 60 * 1000;
export const EXPIRY_EVERY_MS = 5 * 60 * 1000;

const BASE_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

/** Deterministic job ids: adding the same job twice is a no-op, which makes the planner idempotent. */
export const jobIds = {
  slot: (userId: string, at: Date): string => `rem_${userId}_${epochSeconds(at)}`,
  missed: (userId: string, at: Date, round = 0): string =>
    `miss_${userId}_${epochSeconds(at)}${round > 0 ? `_${round}` : ''}`,
  snooze: (userId: string, at: Date, attempt: number): string =>
    `snz_${userId}_${epochSeconds(at)}_${attempt}`,
  alert: (userId: string, at: Date): string => `alr_${userId}_${epochSeconds(at)}`,
  caregiverReply: (waMessageId: string, caregiverId: string): string =>
    `cgr_${waMessageId}_${caregiverId}`.replaceAll(':', '_'),
};

/** Producer side of the `reminders` queue (consumed by ReminderWorker). */
@Injectable()
export class ReminderQueue implements OnModuleDestroy {
  private queue: Queue<ReminderJobData> | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReminderQueue.name);
  }

  getQueue(): Queue<ReminderJobData> {
    if (!this.queue) {
      this.queue = new Queue<ReminderJobData>(REMINDERS_QUEUE, {
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      this.queue.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.warn(`reminders queue error: ${error.code ?? error.name}`);
      });
    }
    return this.queue;
  }

  private async add(
    name: ReminderJobName,
    data: ReminderJobData,
    jobId: string,
    runAt: Date | null,
    now: Date,
  ): Promise<void> {
    const delay = runAt ? Math.max(0, runAt.getTime() - now.getTime()) : 0;
    await withTimeout(
      () => this.getQueue().add(name, data, { ...BASE_OPTIONS, jobId, delay }),
      ENQUEUE_TIMEOUT_MS,
    );
  }

  addSlot(userId: string, at: Date, now: Date = new Date()): Promise<void> {
    return this.add(
      JOB.slot,
      { userId, scheduledAt: at.toISOString() },
      jobIds.slot(userId, at),
      at,
      now,
    );
  }

  addMissed(
    userId: string,
    at: Date,
    runAt: Date,
    round = 0,
    now: Date = new Date(),
  ): Promise<void> {
    return this.add(
      JOB.missed,
      { userId, scheduledAt: at.toISOString() },
      jobIds.missed(userId, at, round),
      runAt,
      now,
    );
  }

  addSnooze(
    userId: string,
    at: Date,
    attempt: number,
    runAt: Date,
    now: Date = new Date(),
  ): Promise<void> {
    return this.add(
      JOB.snooze,
      { userId, scheduledAt: at.toISOString(), attempt },
      jobIds.snooze(userId, at, attempt),
      runAt,
      now,
    );
  }

  addAlert(userId: string, at: Date, now: Date = new Date()): Promise<void> {
    return this.add(
      JOB.alert,
      { userId, scheduledAt: at.toISOString() },
      jobIds.alert(userId, at),
      null,
      now,
    );
  }

  addCaregiverReply(data: CaregiverReplyJobData, now: Date = new Date()): Promise<void> {
    return this.add(
      JOB.caregiverReply,
      data,
      jobIds.caregiverReply(data.waMessageId, data.caregiverId),
      null,
      now,
    );
  }

  /**
   * Remove the queued slot / missed-check / snooze jobs of the given slots (STOP REMINDERS, pause,
   * `[Galti hai]`). The DB rows are the truth: even if a job escapes (it is already running), the
   * worker re-reads the row and finds it cancelled.
   */
  async removeSlotJobs(userId: string, slots: readonly Date[]): Promise<number> {
    const queue = this.getQueue();
    let removed = 0;
    for (const slot of slots) {
      const ids = [
        jobIds.slot(userId, slot),
        jobIds.missed(userId, slot),
        jobIds.missed(userId, slot, 1),
        jobIds.missed(userId, slot, 2),
        jobIds.snooze(userId, slot, 1),
        jobIds.snooze(userId, slot, 2),
      ];
      for (const id of ids) {
        try {
          removed += await queue.remove(id);
        } catch {
          // Locked (running right now) or gone: the worker re-checks the DB anyway.
        }
      }
    }
    return removed;
  }

  /** Register the two repeatable jobs. Idempotent: the scheduler id is fixed. */
  async ensureSchedulers(): Promise<void> {
    const queue = this.getQueue();
    await queue.upsertJobScheduler(
      'planner',
      { every: PLANNER_EVERY_MS },
      {
        name: JOB.planner,
        data: {},
        opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } },
      },
    );
    await queue.upsertJobScheduler(
      'caregiver-expiry',
      { every: EXPIRY_EVERY_MS },
      {
        name: JOB.caregiverExpiry,
        data: {},
        opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } },
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.queue?.close();
    } catch {
      // Redis may already be gone during shutdown.
    }
  }
}

@Module({ providers: [ReminderQueue], exports: [ReminderQueue] })
export class ReminderQueueModule {}
