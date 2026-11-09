import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PinoLogger } from 'nestjs-pino';

import { RedisService } from '../common/redis/redis.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { type BudgetStateName, MetricsService } from '../telemetry/metrics.service';

export type BudgetState = BudgetStateName;

export interface BudgetSnapshot {
  state: BudgetState;
  spentUsd: number;
  /** spent / budget, or 0 when no budget is configured. */
  ratio: number;
}

const MICROS = 1_000_000;
const KEY_TTL_S = 3 * 24 * 3600;

/** Pure: which state a spend ratio maps to (thresholds in percent). */
export function stateForRatio(
  ratio: number,
  economyPct: number,
  essentialPct: number,
): BudgetState {
  const pct = ratio * 100;
  if (pct >= 100) return 'exhausted';
  if (pct >= essentialPct) return 'essential';
  if (pct >= economyPct) return 'economy';
  return 'normal';
}

/** The local (Asia/Kolkata) day a spend belongs to. The budget resets at local midnight. */
export function budgetDay(now: number = Date.now()): string {
  return DateTime.fromMillis(now, { zone: 'Asia/Kolkata' }).toISODate() ?? 'day';
}

/**
 * The daily LLM cost guard (M15). The gateway owns the counters because it sees every AI response
 * (`meta.cost_usd`); the AI service receives the resulting state with each request and degrades:
 *   normal < economy (70%) < essential (90%) < exhausted (100%).
 * Spend is kept in micro-dollars so `INCRBY` stays atomic and exact. Fail-open: if Redis is down the
 * state is `normal` (a broken guard must not take the product down), and the failure is logged.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG)
    private readonly env: Pick<
      Env,
      | 'LLM_DAILY_BUDGET_USD'
      | 'USER_DAILY_COST_USD'
      | 'BUDGET_ECONOMY_PCT'
      | 'BUDGET_ESSENTIAL_PCT'
      | 'DEMO_DAILY_BUDGET_USD'
    >,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BudgetService.name);
  }

  async snapshot(now: number = Date.now()): Promise<BudgetSnapshot> {
    const budget = this.env.LLM_DAILY_BUDGET_USD;
    try {
      const raw = await this.redis.client.get(`budget:day:${budgetDay(now)}`);
      const spentUsd = Number(raw ?? 0) / MICROS;
      const ratio = budget ? spentUsd / budget : 0;
      const state = budget
        ? stateForRatio(ratio, this.env.BUDGET_ECONOMY_PCT, this.env.BUDGET_ESSENTIAL_PCT)
        : 'normal';
      this.publish(state, spentUsd, ratio);
      return { state, spentUsd, ratio };
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'budget read failed, assuming normal');
      return { state: 'normal', spentUsd: 0, ratio: 0 };
    }
  }

  /**
   * M16: the web demo has its OWN daily budget (`DEMO_DAILY_BUDGET_USD`), kept apart from the users'
   * budget so a flood on the public demo can never starve real patients. Unset: no cap (dev only;
   * production requires it when the demo is on). Fail-open on a Redis error is NOT used here: a demo
   * that cannot read its budget refuses uploads (cached samples still work).
   */
  async demoSnapshot(now: number = Date.now()): Promise<{ exhausted: boolean; spentUsd: number }> {
    const cap = this.env.DEMO_DAILY_BUDGET_USD;
    try {
      const raw = await this.redis.client.get(`budget:demo:${budgetDay(now)}`);
      const spentUsd = Number(raw ?? 0) / MICROS;
      return { exhausted: cap !== undefined && spentUsd >= cap, spentUsd };
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'demo budget read failed, uploads off');
      return { exhausted: true, spentUsd: 0 };
    }
  }

  async recordDemo(costUsd: number, now: number = Date.now()): Promise<void> {
    if (!(costUsd > 0)) return;
    const day = budgetDay(now);
    try {
      const pipeline = this.redis.client.multi();
      pipeline.incrby(`budget:demo:${day}`, Math.round(costUsd * MICROS));
      pipeline.expire(`budget:demo:${day}`, KEY_TTL_S);
      await pipeline.exec();
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'demo budget write failed');
    }
  }

  /** M16 (admin): the last `days` local days of spend, oldest first. Users' spend and the web demo's apart. */
  async costSeries(
    days: number,
    now: number = Date.now(),
  ): Promise<{ day: string; usd: number; demoUsd: number }[]> {
    const keys = Array.from({ length: days }, (_, i) =>
      budgetDay(now - (days - 1 - i) * 86_400_000),
    );
    try {
      const [main, demo] = await Promise.all([
        this.redis.client.mget(...keys.map((day) => `budget:day:${day}`)),
        this.redis.client.mget(...keys.map((day) => `budget:demo:${day}`)),
      ]);
      return keys.map((day, i) => ({
        day,
        usd: Number(main[i] ?? 0) / MICROS,
        demoUsd: Number(demo[i] ?? 0) / MICROS,
      }));
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'cost series read failed');
      return keys.map((day) => ({ day, usd: 0, demoUsd: 0 }));
    }
  }

  private publish(state: BudgetState, spentUsd: number, ratio: number): void {
    this.metrics.setBudgetState(state);
    this.metrics.budgetSpendUsd.set(spentUsd);
    this.metrics.budgetSpendRatio.set(ratio);
  }

  /** Add one request's cost (atomic). Also keeps per-model / per-intent / per-user aggregates. */
  async record(
    entry: { userId: string; costUsd: number; model: string | null; intent: string },
    now: number = Date.now(),
  ): Promise<void> {
    if (!(entry.costUsd > 0)) return;
    const micros = Math.round(entry.costUsd * MICROS);
    const day = budgetDay(now);
    this.metrics.aiCostUsd.inc({ intent: entry.intent }, entry.costUsd);
    try {
      const pipeline = this.redis.client.multi();
      pipeline.incrby(`budget:day:${day}`, micros);
      pipeline.expire(`budget:day:${day}`, KEY_TTL_S);
      pipeline.incrby(`budget:user:${entry.userId}:${day}`, micros);
      pipeline.expire(`budget:user:${entry.userId}:${day}`, KEY_TTL_S);
      pipeline.hincrby(`budget:model:${day}`, entry.model ?? 'none', micros);
      pipeline.expire(`budget:model:${day}`, KEY_TTL_S);
      pipeline.hincrby(`budget:intent:${day}`, entry.intent, micros);
      pipeline.expire(`budget:intent:${day}`, KEY_TTL_S);
      pipeline.pfadd(`budget:users:${day}`, entry.userId);
      pipeline.expire(`budget:users:${day}`, KEY_TTL_S);
      await pipeline.exec();
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'budget write failed');
    }
  }

  /** True when this user already used their share of today's budget (USER_DAILY_COST_USD). */
  async userOverCap(userId: string, now: number = Date.now()): Promise<boolean> {
    const cap = this.env.USER_DAILY_COST_USD;
    if (!cap) return false;
    try {
      const raw = await this.redis.client.get(`budget:user:${userId}:${budgetDay(now)}`);
      return Number(raw ?? 0) / MICROS >= cap;
    } catch {
      return false;
    }
  }

  /** Aggregates for the 23:55 report: totals by model and intent and the number of active users. */
  async dailyReport(day: string): Promise<{
    day: string;
    totalUsd: number;
    byModel: Record<string, number>;
    byIntent: Record<string, number>;
    activeUsers: number;
    perActiveUserUsd: number;
  }> {
    const toUsd = (map: Record<string, string>): Record<string, number> =>
      Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Number(v) / MICROS]));
    const [total, byModel, byIntent, activeUsers] = await Promise.all([
      this.redis.client.get(`budget:day:${day}`),
      this.redis.client.hgetall(`budget:model:${day}`),
      this.redis.client.hgetall(`budget:intent:${day}`),
      this.redis.client.pfcount(`budget:users:${day}`),
    ]);
    const totalUsd = Number(total ?? 0) / MICROS;
    return {
      day,
      totalUsd,
      byModel: toUsd(byModel),
      byIntent: toUsd(byIntent),
      activeUsers,
      perActiveUserUsd: activeUsers > 0 ? totalUsd / activeUsers : 0,
    };
  }
}
