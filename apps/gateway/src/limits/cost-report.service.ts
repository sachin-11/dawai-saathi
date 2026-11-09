import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Job, Queue, type Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { WorkerFactory } from '../telemetry/worker-factory.service';
import { BudgetService, budgetDay } from './budget.service';

export const OPS_QUEUE = 'ops';
export const COST_REPORT_JOB = 'daily-cost-report';
/** 23:55 every day, Asia/Kolkata. */
export const COST_REPORT_CRON = '55 23 * * *';

/**
 * The daily cost report (M15): one structured log line with the day's spend by model and by intent
 * and the cost per active user. Aggregates only: no user id, no text. Runs as a repeatable BullMQ job
 * so only one instance writes it even when several gateways run.
 */
@Injectable()
export class CostReportService implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly budget: BudgetService,
    private readonly workers: WorkerFactory,
    @Inject(APP_CONFIG) private readonly env: Pick<Env, 'WORKERS_ENABLED' | 'NODE_ENV'>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CostReportService.name);
  }

  async onModuleInit(): Promise<void> {
    if (!this.env.WORKERS_ENABLED || this.env.NODE_ENV === 'test') return;
    this.worker = this.workers.create(OPS_QUEUE, (job) => this.run(job), {
      connection: this.redis.createConnection({ maxRetriesPerRequest: null }),
      concurrency: 1,
    });
    this.worker.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.warn(`ops worker error: ${error.code ?? error.name}`);
    });
    try {
      this.queue = new Queue(OPS_QUEUE, {
        connection: this.redis.createConnection({ maxRetriesPerRequest: 1 }),
      });
      this.queue.on('error', () => undefined);
      await this.queue.upsertJobScheduler(
        COST_REPORT_JOB,
        { pattern: COST_REPORT_CRON, tz: 'Asia/Kolkata' },
        {
          name: COST_REPORT_JOB,
          data: {},
          opts: { removeOnComplete: { count: 7 }, removeOnFail: { count: 7 } },
        },
      );
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'could not register the cost report');
    }
  }

  async run(job: Pick<Job, 'name'>, now: number = Date.now()): Promise<void> {
    if (job.name !== COST_REPORT_JOB) return;
    await this.report(now);
  }

  async report(now: number = Date.now()): Promise<void> {
    const report = await this.budget.dailyReport(budgetDay(now));
    this.logger.info(
      {
        event: 'daily_cost_report',
        day: report.day,
        total_usd: round(report.totalUsd),
        by_model: roundAll(report.byModel),
        by_intent: roundAll(report.byIntent),
        active_users: report.activeUsers,
        per_active_user_usd: round(report.perActiveUserUsd),
      },
      'daily LLM cost report',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.workers.close(this.worker);
    await this.queue?.close().catch(() => undefined);
  }
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const roundAll = (map: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [key, round(value)]));
