/**
 * M15 against REAL Redis, Postgres and BullMQ (no mocks for them):
 *   - the sliding-window Lua script, notices, abuse blocking written to `users.blocked_until`
 *   - the daily budget in Redis and its state machine
 *   - dead letters: a job that runs out of attempts lands in `<queue>-dlq` without its payload, the
 *     inbound user is told exactly once, an erasure that cannot finish raises the alert log line
 *   - the operator retry (audited)
 *   - graceful worker shutdown with a job in flight
 *   - one trace id from the producer span through the BullMQ job into the worker span
 */
import { randomUUID } from 'node:crypto';

import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Queue, UnrecoverableError } from 'bullmq';

import { AuditService } from '../../src/audit/audit.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { type Env, validateEnv } from '../../src/config/env.schema';
import { DlqEffects } from '../../src/queues/dlq-effects.service';
import { BudgetService, budgetDay } from '../../src/limits/budget.service';
import { RateLimitService } from '../../src/limits/rate-limit.service';
import { RedisWindowStore } from '../../src/limits/sliding-window';
import { DlqAdminService } from '../../src/telemetry/dlq-admin.service';
import { DlqService } from '../../src/telemetry/dlq.service';
import { QueueMetricsCollector } from '../../src/telemetry/queue-metrics.collector';
import { MetricsService } from '../../src/telemetry/metrics.service';
import { withTrace } from '../../src/telemetry/trace-context';
import { WorkerFactory } from '../../src/telemetry/worker-factory.service';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as never;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(25);
  }
  throw new Error('condition not met in time');
}

describe('observability, limits and dead letters (integration)', () => {
  let env: Env;
  let prisma: PrismaService;
  let redis: RedisService;
  let metrics: MetricsService;
  let dlq: DlqService;
  let factory: WorkerFactory;
  const queues: Queue[] = [];
  const userIds: string[] = [];

  const connection = (): ReturnType<RedisService['createConnection']> =>
    redis.createConnection({ maxRetriesPerRequest: null });
  const makeQueue = (name: string): Queue => {
    const queue = new Queue(name, { connection: connection() });
    queues.push(queue);
    return queue;
  };
  async function reset(name: string): Promise<void> {
    await makeQueue(name).obliterate({ force: true });
    await dlq.queue(name).obliterate({ force: true });
  }
  async function newUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { waPhoneHash: `hash-${randomUUID()}`, waPhoneEnc: 'enc:test' },
    });
    userIds.push(user.id);
    return user.id;
  }

  beforeAll(async () => {
    env = validateEnv({
      ...INTEGRATION_ENV,
      LLM_DAILY_BUDGET_USD: '10',
      USER_DAILY_COST_USD: '1',
      SHUTDOWN_GRACE_S: '1',
      RL_MSG_PER_MIN: '3',
      RL_BLOCK_AFTER_WINDOWS: '2',
    });
    prepareTestDatabase(env.DATABASE_URL);
    prisma = new PrismaService(env);
    redis = new RedisService(env);
    metrics = new MetricsService();
    dlq = new DlqService(redis, metrics, logger);
    factory = new WorkerFactory(metrics, dlq, env, logger);
    for (const key of await redis.client.keys('rl:*')) await redis.client.del(key);
    for (const key of await redis.client.keys('budget:*')) await redis.client.del(key);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await Promise.all(queues.map((queue) => queue.close()));
    await dlq.onModuleDestroy();
    await prisma.onModuleDestroy();
    await redis.onModuleDestroy();
  });

  describe('sliding window in Redis', () => {
    const store = (): RedisWindowStore => new RedisWindowStore(redis);

    it('counts events, refuses past the limit and says when the oldest leaves', async () => {
      const key = `rl:test:${randomUUID()}`;
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        expect((await store().hit(key, 3, 60_000, now + i * 1000)).allowed).toBe(true);
      }
      const refused = await store().hit(key, 3, 60_000, now + 5000);
      expect(refused).toMatchObject({ allowed: false, count: 3 });
      expect(refused.retryAfterMs).toBe(55_000);
      expect((await store().hit(key, 3, 60_000, now + 61_000)).allowed).toBe(true);
    });

    it('a retried event (same member) is allowed again and counted once', async () => {
      const key = `rl:test:${randomUUID()}`;
      await store().hit(key, 1, 60_000, Date.now(), 'msg-1');
      expect((await store().hit(key, 1, 60_000, Date.now(), 'msg-1')).allowed).toBe(true);
      expect((await store().hit(key, 1, 60_000, Date.now(), 'msg-2')).allowed).toBe(false);
    });

    it('is atomic: 50 concurrent hits against a limit of 10 let exactly 10 through', async () => {
      const key = `rl:test:${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 50 }, () => store().hit(key, 10, 60_000)),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(10);
    });

    it('once() and bump() behave like a marker and a counter with a ttl', async () => {
      const key = `rl:test:${randomUUID()}`;
      expect(await store().once(key, 5000)).toBe(true);
      expect(await store().once(key, 5000)).toBe(false);
      const counter = `rl:test:${randomUUID()}`;
      expect(await store().bump(counter, 60)).toBe(1);
      expect(await store().bump(counter, 60)).toBe(2);
      expect(await redis.client.ttl(counter)).toBeGreaterThan(0);
    });
  });

  describe('rate limiting and abuse blocking (real Redis + real users table)', () => {
    it('limits, notifies once, blocks after repeated limited windows and unblocks with an audit row', async () => {
      const userId = await newUser();
      const audit = new AuditService(prisma);
      const service = new RateLimitService(
        new RedisWindowStore(redis),
        metrics,
        prisma,
        audit,
        env,
        logger,
      );
      const decisions = [];
      let at = Date.now();
      for (let round = 0; round < 4; round++) {
        for (let i = 0; i < 5; i++) decisions.push(await service.checkMessage(userId, 'text', at));
        at += 61_000; // next minute: a new limited window
        await redis.client.del(`rl:notice:msg_min:${userId}`); // the notice marker is real-time based
      }
      expect(decisions.some((d) => !d.allowed && d.notify)).toBe(true);
      expect(decisions.some((d) => !d.allowed && !d.notify)).toBe(true);
      expect(decisions.some((d) => !d.allowed && d.blocked)).toBe(true);

      const blocked = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(blocked.blockedUntil?.getTime()).toBeGreaterThan(Date.now());
      expect(blocked.blockReason).toBe('rate_limit');
      expect(await prisma.auditLog.count({ where: { userId, action: 'user_blocked' } })).toBe(1);

      expect(await service.unblock(userId)).toBe(true);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).blockedUntil,
      ).toBeNull();
      expect(await prisma.auditLog.count({ where: { userId, action: 'user_unblocked' } })).toBe(1);
    });
  });

  describe('daily budget', () => {
    it('moves normal -> economy -> essential -> exhausted as spend is recorded, and caps one user', async () => {
      const budget = new BudgetService(redis, metrics, env, logger);
      const user = randomUUID();
      const other = randomUUID();
      expect((await budget.snapshot()).state).toBe('normal');
      await budget.record({ userId: user, costUsd: 7, model: 'm-a', intent: 'prescription' });
      expect((await budget.snapshot()).state).toBe('economy');
      await budget.record({ userId: other, costUsd: 2.1, model: 'm-b', intent: 'help' });
      expect((await budget.snapshot()).state).toBe('essential');
      await budget.record({ userId: other, costUsd: 1, model: 'm-b', intent: 'help' });
      const final = await budget.snapshot();
      expect(final.state).toBe('exhausted');
      expect(final.spentUsd).toBeCloseTo(10.1, 6);

      expect(await budget.userOverCap(user)).toBe(true); // 7 >= 1
      expect(await budget.userOverCap(randomUUID())).toBe(false);

      const day = new Date().toISOString(); // only to prove the report API shape
      expect(day).toBeTruthy();
      const report = await budget.dailyReport(budgetDay());
      expect(report.totalUsd).toBeCloseTo(10.1, 6);
      expect(report.byModel['m-a']).toBeCloseTo(7, 6);
      expect(report.byIntent['help']).toBeCloseTo(3.1, 6);
      expect(report.activeUsers).toBe(2);
      expect(await metrics.render()).toMatch(/^budget_state 3$/m);
    });
  });

  describe('dead letters', () => {
    const data = (): { userId: string; messageId: string; requestId: string; text: string } => ({
      userId: randomUUID(),
      messageId: randomUUID(),
      requestId: 'req',
      text: 'a private message that must never reach the dead-letter entry',
    });

    it('moves an exhausted inbound job to inbound-dlq (no payload), tells the user once, then an operator can retry it', async () => {
      await reset('inbound');
      const inbound = makeQueue('inbound');
      const told: [number, string][] = [];
      const effects = new DlqEffects(
        dlq,
        { getState: jest.fn().mockResolvedValue({ id: 'u', language: 'hi' }) } as never,
        {
          session: () => ({
            textAt: (index: number, key: string) => {
              told.push([index, key]);
              return Promise.resolve();
            },
          }),
        } as never,
        logger,
      );
      effects.onModuleInit();

      let attempts = 0;
      let failing = true;
      const worker = factory.create<ReturnType<typeof data>>(
        'inbound',
        () => {
          attempts += 1;
          if (failing) throw new Error('AI service down: private text inside the message');
          return Promise.resolve();
        },
        { connection: connection(), concurrency: 1 },
      );
      worker.on('error', () => undefined);

      const payload = data();
      await inbound.add('text', payload, {
        attempts: 3,
        backoff: { type: 'fixed', delay: 20 },
        removeOnFail: false,
        jobId: `wamid.${randomUUID()}`,
      });
      await until(async () => (await dlq.queue('inbound').getJobCounts('waiting')).waiting === 1);

      expect(attempts).toBe(3); // nothing in the DLQ before the last attempt
      const [entry] = await dlq.queue('inbound').getJobs(['waiting']);
      const stored = entry?.data as Record<string, unknown>;
      expect(stored).toMatchObject({
        sourceQueue: 'inbound',
        attemptsMade: 3,
        userId: payload.userId,
        messageId: payload.messageId,
        errorCode: 'Error',
      });
      expect(JSON.stringify(stored)).not.toMatch(/private/); // no payload, no error message
      await until(() => told.length === 1);
      expect(told).toEqual([[99, 'common.error_try_again']]);
      expect(await metrics.render()).toMatch(/dlq_moved_total\{queue="inbound"\} 1/);
      expect(await metrics.render()).toMatch(
        /job_failed_total\{queue="inbound",reason="error"\} 3/,
      );

      // operator: retry from the CLI service; the original job runs again and succeeds
      failing = false;
      const audit = new AuditService(prisma);
      const admin = new DlqAdminService(dlq, redis, audit);
      const listing = await admin.list('inbound');
      expect(listing.size).toBe(1);
      expect(await admin.retry('inbound')).toEqual({ retried: 1, missing: 0 });
      await until(async () => (await inbound.getJobCounts('completed')).completed === 1);
      expect((await admin.list('inbound')).size).toBe(0);
      expect(
        await prisma.auditLog.count({ where: { action: 'dlq_retry', actor: 'admin' } }),
      ).toBeGreaterThanOrEqual(1);
      await admin.onModuleDestroy();
      await factory.close(worker);
    });

    it('an unrecoverable job goes to the DLQ at once, without further attempts', async () => {
      await reset('outbound');
      const outbound = makeQueue('outbound');
      let runs = 0;
      const worker = factory.create(
        'outbound',
        () => {
          runs += 1;
          return Promise.reject(new UnrecoverableError('recipient no longer exists'));
        },
        { connection: connection() },
      );
      worker.on('error', () => undefined);
      await outbound.add('send', data(), { attempts: 5, removeOnFail: false });
      await until(async () => (await dlq.queue('outbound').getJobCounts('waiting')).waiting === 1);
      expect(runs).toBe(1);
      await factory.close(worker);
    });

    it('a stuck erasure raises the alert log line and shows in dlq_size', async () => {
      await reset('user-deletion');
      const lines: Record<string, unknown>[] = [];
      const effects = new DlqEffects(
        dlq,
        {} as never,
        {} as never,
        { setContext: jest.fn(), error: (o: Record<string, unknown>) => lines.push(o) } as never,
      );
      effects.onModuleInit();
      const queue = makeQueue('user-deletion');
      const worker = factory.create(
        'user-deletion',
        () => Promise.reject(new Error('s3 unreachable')),
        { connection: connection() },
      );
      worker.on('error', () => undefined);
      await queue.add('delete-user', data(), {
        attempts: 2,
        backoff: { type: 'fixed', delay: 10 },
        removeOnFail: false,
      });
      await until(() => lines.some((line) => line['event'] === 'user_erasure_dlq'));
      const collector = new QueueMetricsCollector(redis, metrics, env, logger);
      await collector.sample();
      expect(await metrics.render()).toMatch(/dlq_size\{queue="user-deletion"\} 1/);
      await collector.onModuleDestroy();
      await factory.close(worker);
    });
  });

  describe('graceful shutdown', () => {
    it('lets a job in flight finish inside the grace period', async () => {
      await reset('reminders');
      const queue = makeQueue('reminders');
      let finished = false;
      const worker = factory.create(
        'reminders',
        async () => {
          await wait(300);
          finished = true;
        },
        { connection: connection() },
      );
      worker.on('error', () => undefined);
      await queue.add('slot', data0());
      await until(async () => (await queue.getJobCounts('active')).active === 1);
      const started = Date.now();
      await factory.close(worker); // SHUTDOWN_GRACE_S = 1
      expect(finished).toBe(true);
      expect(Date.now() - started).toBeLessThan(900);
      expect((await queue.getJobCounts('completed')).completed).toBe(1);
    });

    it('closes forcibly when the job outlasts the grace period, and does not hang', async () => {
      await reset('reminders');
      const queue = makeQueue('reminders');
      const worker = factory.create('reminders', () => wait(8000), { connection: connection() });
      worker.on('error', () => undefined);
      await queue.add('slot', data0());
      await until(async () => (await queue.getJobCounts('active')).active === 1);
      const started = Date.now();
      await factory.close(worker);
      // grace (1 s) + the forced-close cap (2 s) + slack; the job itself would take 8 s
      expect(Date.now() - started).toBeLessThan(4500);
    });

    function data0(): { userId: string } {
      return { userId: randomUUID() };
    }
  });

  describe('one trace across a BullMQ job', () => {
    it('the worker span is a child of the producer span (same trace id)', async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      provider.register({ propagator: new W3CTraceContextPropagator() });
      try {
        await reset('inbound');
        const queue = makeQueue('inbound');
        let seen = '';
        const worker = factory.create(
          'inbound',
          () => {
            seen = trace.getActiveSpan()?.spanContext().traceId ?? '';
            return Promise.resolve();
          },
          { connection: connection() },
        );
        worker.on('error', () => undefined);

        const tracer = trace.getTracer('test');
        const producer = tracer.startSpan('POST /webhook', { kind: SpanKind.SERVER });
        await context.with(trace.setSpan(context.active(), producer), () =>
          queue.add('text', withTrace({ userId: randomUUID() })),
        );
        producer.end();
        await until(() => seen !== '');
        await factory.close(worker);

        expect(seen).toBe(producer.spanContext().traceId);
        const spans = exporter.getFinishedSpans();
        const consumer = spans.find((span) => span.name === 'inbound process');
        expect(consumer?.parentSpanContext?.spanId).toBe(producer.spanContext().spanId);
        expect(consumer?.attributes['dawai.queue']).toBe('inbound');
      } finally {
        await provider.shutdown();
        trace.disable();
        context.disable();
        propagation.disable();
      }
    });
  });
});
