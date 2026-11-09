import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Job, Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { CaregiversService } from '../caregivers/caregivers.service';
import { RedisService } from '../common/redis/redis.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { WorkerFactory } from '../telemetry/worker-factory.service';
import { ReminderDispatchService } from './reminder-dispatch.service';
import { ReminderPlannerService } from './reminder-planner.service';
import {
  type CaregiverReplyJobData,
  JOB,
  type ReminderJobData,
  REMINDERS_QUEUE,
  ReminderQueue,
  type SlotJobData,
  type SnoozeJobData,
} from './reminder.queue';

/**
 * Consumer of the `reminders` queue. One worker, small jobs, every handler re-reads the database.
 * Logs carry ids and counts only (no phone, no medicine name, no text).
 */
@Injectable()
export class ReminderWorker implements OnModuleInit, OnModuleDestroy {
  private worker: Worker<ReminderJobData> | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly queue: ReminderQueue,
    private readonly workers: WorkerFactory,
    private readonly dispatch: ReminderDispatchService,
    private readonly planner: ReminderPlannerService,
    private readonly caregivers: CaregiversService,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReminderWorker.name);
  }

  async onModuleInit(): Promise<void> {
    if (!this.env.WORKERS_ENABLED) {
      this.logger.info('reminder worker disabled (WORKERS_ENABLED=false)');
      return;
    }
    this.worker = this.workers.create<ReminderJobData>(
      REMINDERS_QUEUE,
      (job) => this.process(job),
      {
        connection: this.redis.createConnection({ maxRetriesPerRequest: null }),
        concurrency: 5,
      },
    );
    this.worker.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.warn(`reminder worker error: ${error.code ?? error.name}`);
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        {
          job_id: job?.id,
          job_name: job?.name,
          attempts_made: job?.attemptsMade,
          error: error.name,
        },
        'reminder job failed',
      );
    });
    try {
      await this.queue.ensureSchedulers();
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'could not register reminder schedulers');
    }
  }

  /** Public so tests (and the lifecycle test) can drive a job without Redis. */
  async process(
    job: Pick<Job<ReminderJobData>, 'name' | 'data' | 'id'>,
    now: Date = new Date(),
  ): Promise<string> {
    switch (job.name) {
      case JOB.slot: {
        const data = job.data as SlotJobData;
        return this.dispatch.sendSlot(data.userId, new Date(data.scheduledAt), now);
      }
      case JOB.snooze: {
        const data = job.data as SnoozeJobData;
        return this.dispatch.sendSlot(data.userId, new Date(data.scheduledAt), now, data.attempt);
      }
      case JOB.missed: {
        const data = job.data as SlotJobData;
        const result = await this.dispatch.checkMissed(
          data.userId,
          new Date(data.scheduledAt),
          now,
        );
        return `missed:${result.missed}`;
      }
      case JOB.alert: {
        const data = job.data as SlotJobData;
        const result = await this.caregivers.alertMissedDose(
          data.userId,
          new Date(data.scheduledAt),
          now,
        );
        return `alert:${result.outcome}`;
      }
      case JOB.caregiverReply:
        return `caregiver_reply:${await this.caregivers.handleReply(job.data as CaregiverReplyJobData, now)}`;
      case JOB.planner: {
        const stats = await this.planner.planAll(now);
        return `planner:${stats.rowsCreated}`;
      }
      case JOB.caregiverExpiry:
        return `expiry:${await this.caregivers.expireInvites(now)}`;
      default:
        this.logger.warn({ job_name: job.name }, 'unknown reminder job');
        return 'unknown';
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.workers.close(this.worker);
  }
}
