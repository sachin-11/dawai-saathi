import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { RedisService } from '../common/redis/redis.service';
import { MetricsService } from '../telemetry/metrics.service';
import { BudgetService, budgetDay, stateForRatio } from './budget.service';
import { CostReportService } from './cost-report.service';
import { RateLimitService } from './rate-limit.service';
import { InMemoryWindowStore } from './sliding-window';

const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function limiter(overrides: Partial<ConstructorParameters<typeof RateLimitService>[4]> = {}) {
  let now = Date.UTC(2026, 10, 9, 6, 0, 0); // 11:30 IST
  const store = new InMemoryWindowStore(() => now);
  const prisma = { user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const metrics = new MetricsService();
  const service = new RateLimitService(
    store,
    metrics,
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    {
      RL_MSG_PER_MIN: 3,
      RL_MSG_PER_DAY: 6,
      RL_DOCS_PER_DAY: 2,
      RL_VOICE_PER_DAY: 2,
      RL_CAREGIVER_INVITES_PER_DAY: 3,
      RL_BLOCK_AFTER_WINDOWS: 2,
      RL_BLOCK_HOURS: 24,
      ...overrides,
    },
    logger as never,
  );
  return {
    service,
    prisma,
    audit,
    metrics,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

describe('sliding window store', () => {
  it('lets events through up to the limit, then refuses until the oldest leaves the window', async () => {
    let now = 1_000;
    const store = new InMemoryWindowStore(() => now);
    for (let i = 0; i < 3; i++) {
      expect((await store.hit('k', 3, 60_000, now)).allowed).toBe(true);
      now += 10_000;
    }
    const refused = await store.hit('k', 3, 60_000, now);
    expect(refused).toMatchObject({ allowed: false, count: 3 });
    expect(refused.retryAfterMs).toBe(30_000); // oldest event at 1 000 leaves at 61 000, now is 31 000
    now = 61_001;
    expect((await store.hit('k', 3, 60_000, now)).allowed).toBe(true);
  });

  it('is a SLIDING window, not a fixed one: the boundary does not reset the count', async () => {
    const store = new InMemoryWindowStore();
    await store.hit('k', 2, 60_000, 59_000);
    await store.hit('k', 2, 60_000, 59_500);
    expect((await store.hit('k', 2, 60_000, 61_000)).allowed).toBe(false);
  });

  it('counts a retried event once (same member) and still lets it through when full', async () => {
    const store = new InMemoryWindowStore();
    await store.hit('k', 1, 60_000, 1, 'msg-1');
    expect((await store.hit('k', 1, 60_000, 2, 'msg-1')).allowed).toBe(true);
    expect((await store.hit('k', 1, 60_000, 3, 'msg-2')).allowed).toBe(false);
  });

  it('once() is true only for the first caller inside the ttl', async () => {
    let now = 0;
    const store = new InMemoryWindowStore(() => now);
    expect(await store.once('n', 1000)).toBe(true);
    expect(await store.once('n', 1000)).toBe(false);
    now = 1001;
    expect(await store.once('n', 1000)).toBe(true);
  });
});

describe('RateLimitService', () => {
  it('allows ordinary traffic', async () => {
    const { service } = limiter();
    expect(await service.checkMessage('u1', 'text')).toEqual({ allowed: true });
  });

  it('sends ONE friendly notice per window, then drops silently', async () => {
    const { service, metrics } = limiter();
    for (let i = 0; i < 3; i++) await service.checkMessage('u1', 'text');
    const first = await service.checkMessage('u1', 'text');
    const second = await service.checkMessage('u1', 'text');
    const third = await service.checkMessage('u1', 'text');
    expect(first).toMatchObject({ allowed: false, scope: 'msg_min', notify: true });
    expect(second).toMatchObject({ allowed: false, scope: 'msg_min', notify: false });
    expect(third).toMatchObject({ allowed: false, notify: false });
    expect((await metrics.registry.getSingleMetricAsString('rate_limited_total')).trim()).toMatch(
      /rate_limited_total\{scope="msg_min"\} 3/,
    );
  });

  it('the minute limit lifts after a minute', async () => {
    const { service, advance, at } = limiter();
    for (let i = 0; i < 4; i++) await service.checkMessage('u1', 'text', at());
    expect(await service.checkMessage('u1', 'text', at())).toMatchObject({ allowed: false });
    advance(61_000);
    expect(await service.checkMessage('u1', 'text', at())).toEqual({ allowed: true });
  });

  it('a retried inbound job (same message id) does not use up the quota', async () => {
    const { service } = limiter({ RL_MSG_PER_MIN: 1 });
    expect((await service.checkMessage('u1', 'text', undefined, 'm1')).allowed).toBe(true);
    for (let retry = 0; retry < 4; retry++) {
      expect((await service.checkMessage('u1', 'text', undefined, 'm1')).allowed).toBe(true);
    }
    expect((await service.checkMessage('u1', 'text', undefined, 'm2')).allowed).toBe(false);
  });

  it('files and voice notes have their own daily limits', async () => {
    const { service } = limiter();
    await service.checkMessage('u1', 'document');
    await service.checkMessage('u1', 'document');
    expect(await service.checkMessage('u1', 'document')).toMatchObject({
      allowed: false,
      scope: 'docs_day',
    });
    // a different user, and plain text of the same user, are unaffected
    expect((await service.checkMessage('u2', 'document')).allowed).toBe(true);
    const { service: other } = limiter();
    await other.checkMessage('u1', 'voice');
    await other.checkMessage('u1', 'voice');
    expect(await other.checkMessage('u1', 'voice')).toMatchObject({ scope: 'voice_day' });
  });

  it('caregiver invitations: 3 a day', async () => {
    const { service } = limiter();
    for (let i = 0; i < 3; i++) {
      expect((await service.checkCaregiverInvite('u1')).allowed).toBe(true);
    }
    expect(await service.checkCaregiverInvite('u1')).toMatchObject({
      allowed: false,
      scope: 'caregiver_invites',
    });
  });

  it('blocks a user after too many limited windows in one day, audited, and can unblock', async () => {
    const { service, prisma, audit, advance } = limiter();
    let blocked = false;
    for (let round = 0; round < 4 && !blocked; round++) {
      for (let i = 0; i < 4; i++) {
        const decision = await service.checkMessage('u1', 'text');
        if (!decision.allowed && decision.blocked) blocked = true;
      }
      advance(61_000); // a new minute window each round
    }
    expect(blocked).toBe(true);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ blockReason: 'rate_limit' }) as unknown,
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_blocked', userId: 'u1', actor: 'system' }),
    );
    expect(await service.unblock('u1')).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_unblocked', actor: 'admin' }),
    );
  });

  it('writes no phone number, text or name into the audit metadata', async () => {
    const { service, audit } = limiter();
    await service.block('u1', 'operator');
    const metadata = (audit.log.mock.calls[0] as [{ metadata: object }])[0].metadata;
    expect(metadata).toEqual({ reason: 'operator', hours: 24 });
  });

  it('allows the message when the limiter itself is down (fail open)', async () => {
    const { service } = limiter();
    (service as unknown as { store: { hit: () => never } }).store = {
      hit: () => {
        throw new Error('redis down');
      },
    };
    expect(await service.checkMessage('u1', 'text')).toEqual({ allowed: true });
  });

  it('gives a blocked user ONE notice per block', async () => {
    const { service, at } = limiter();
    const until = new Date(at() + 3600_000);
    expect(await service.noticeForBlock('u1', until, at())).toBe(true);
    expect(await service.noticeForBlock('u1', until, at())).toBe(false);
  });
});

describe('daily budget', () => {
  it.each([
    [0, 'normal'],
    [0.699, 'normal'],
    [0.7, 'economy'],
    [0.899, 'economy'],
    [0.9, 'essential'],
    [0.999, 'essential'],
    [1, 'exhausted'],
    [4, 'exhausted'],
  ])('ratio %s -> %s', (ratio, state) => {
    expect(stateForRatio(ratio, 70, 90)).toBe(state);
  });

  it('the budget day is the Asia/Kolkata day (resets at local midnight)', () => {
    expect(budgetDay(Date.UTC(2026, 10, 9, 18, 29, 0))).toBe('2026-11-09'); // 23:59 IST
    expect(budgetDay(Date.UTC(2026, 10, 9, 18, 31, 0))).toBe('2026-11-10'); // 00:01 IST
  });

  function budgetWith(spentMicros: number | null, budgetUsd: number | null = 10) {
    const pipeline = {
      incrby: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      hincrby: jest.fn().mockReturnThis(),
      pfadd: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    const client = {
      get: jest.fn().mockResolvedValue(spentMicros === null ? null : String(spentMicros)),
      multi: jest.fn().mockReturnValue(pipeline),
    };
    const metrics = new MetricsService();
    const service = new BudgetService(
      { client } as unknown as RedisService,
      metrics,
      {
        LLM_DAILY_BUDGET_USD: budgetUsd ?? undefined,
        USER_DAILY_COST_USD: 1,
        BUDGET_ECONOMY_PCT: 70,
        BUDGET_ESSENTIAL_PCT: 90,
      },
      logger as never,
    );
    return { service, client, pipeline, metrics };
  }

  it('walks normal -> economy -> essential -> exhausted as the spend grows', async () => {
    const states: string[] = [];
    for (const spent of [1, 7, 9.5, 10]) {
      states.push((await budgetWith(spent * 1e6).service.snapshot()).state);
    }
    expect(states).toEqual(['normal', 'economy', 'essential', 'exhausted']);
  });

  it('publishes the state and the spend as metrics', async () => {
    const { service, metrics } = budgetWith(9.5e6);
    await service.snapshot();
    const text = await metrics.render();
    expect(text).toMatch(/^budget_state 2$/m);
    expect(text).toMatch(/^budget_spend_ratio 0\.95$/m);
  });

  it('is always normal without a budget, and fails open when Redis is down', async () => {
    expect((await budgetWith(99e6, null).service.snapshot()).state).toBe('normal');
    const broken = budgetWith(0);
    broken.client.get.mockRejectedValue(new Error('down'));
    expect((await broken.service.snapshot()).state).toBe('normal');
  });

  it('records spend atomically in micro-dollars with per-model, per-intent and per-user aggregates', async () => {
    const { service, pipeline } = budgetWith(0);
    await service.record({
      userId: 'u1',
      costUsd: 0.0123456,
      model: 'm-1',
      intent: 'prescription',
    });
    expect(pipeline.incrby).toHaveBeenCalledWith(expect.stringMatching(/^budget:day:/), 12346);
    expect(pipeline.hincrby).toHaveBeenCalledWith(
      expect.stringMatching(/^budget:model:/),
      'm-1',
      12346,
    );
    expect(pipeline.hincrby).toHaveBeenCalledWith(
      expect.stringMatching(/^budget:intent:/),
      'prescription',
      12346,
    );
    expect(pipeline.incrby).toHaveBeenCalledWith(expect.stringMatching(/^budget:user:u1:/), 12346);
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
  });

  it('ignores a zero cost and survives a Redis failure', async () => {
    const { service, pipeline } = budgetWith(0);
    await service.record({ userId: 'u1', costUsd: 0, model: null, intent: 'help' });
    expect(pipeline.exec).not.toHaveBeenCalled();
    pipeline.exec.mockRejectedValue(new Error('down'));
    await expect(
      service.record({ userId: 'u1', costUsd: 1, model: null, intent: 'help' }),
    ).resolves.toBeUndefined();
  });

  it('caps one user at USER_DAILY_COST_USD', async () => {
    expect(await budgetWith(1.5e6).service.userOverCap('u1')).toBe(true);
    expect(await budgetWith(0.5e6).service.userOverCap('u1')).toBe(false);
  });
});

describe('daily cost report', () => {
  it('logs aggregates only: by model, by intent, per active user (no user ids)', async () => {
    const report = {
      day: '2026-11-09',
      totalUsd: 1.5,
      byModel: { m1: 1, m2: 0.5 },
      byIntent: { prescription: 1.2, help: 0.3 },
      activeUsers: 3,
      perActiveUserUsd: 0.5,
    };
    const lines: Record<string, unknown>[] = [];
    const service = new CostReportService(
      {} as RedisService,
      { dailyReport: jest.fn().mockResolvedValue(report) } as unknown as BudgetService,
      {} as never,
      { WORKERS_ENABLED: true, NODE_ENV: 'test' },
      { setContext: jest.fn(), info: (o: Record<string, unknown>) => lines.push(o) } as never,
    );
    await service.report(Date.UTC(2026, 10, 9, 18, 25));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'daily_cost_report',
      total_usd: 1.5,
      active_users: 3,
      per_active_user_usd: 0.5,
      by_intent: { prescription: 1.2, help: 0.3 },
    });
    expect(JSON.stringify(lines[0])).not.toMatch(/user_id|userId/);
  });
});
