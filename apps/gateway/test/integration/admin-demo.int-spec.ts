/**
 * M16 against REAL Postgres, Redis and MinIO (only the AI service is a stub):
 *   - admin stats: the raw SQL (documents per day, reminders, emergencies) runs and returns the right numbers
 *   - review queue -> reveal (audit row with the operator and the reason, 60 s link) -> resolve (leaves the queue)
 *   - no phone number anywhere in an admin response
 *   - demo upload: object under demo/ is gone afterwards, NOTHING is written to documents/messages/medications,
 *     the demo budget is counted apart from the users' budget, an exhausted demo budget refuses uploads
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import sharp from 'sharp';

import { AiClient } from '../../src/ai-client/ai-client';
import { AdminService } from '../../src/admin/admin.service';
import { AuditService } from '../../src/audit/audit.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { type Env, validateEnv } from '../../src/config/env.schema';
import { DemoCacheService } from '../../src/demo/demo-cache.service';
import { DemoService } from '../../src/demo/demo.service';
import { TurnstileService } from '../../src/demo/turnstile.service';
import { BudgetService, budgetDay } from '../../src/limits/budget.service';
import { RedisWindowStore } from '../../src/limits/sliding-window';
import { DlqAdminService } from '../../src/telemetry/dlq-admin.service';
import { DlqService } from '../../src/telemetry/dlq.service';
import { MetricsService } from '../../src/telemetry/metrics.service';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as never;

describe('admin API and web demo (integration)', () => {
  let env: Env;
  let prisma: PrismaService;
  let redis: RedisService;
  let storage: StorageService;
  let budget: BudgetService;
  let audit: AuditService;
  let admin: AdminService;
  let dlq: DlqService;
  let demo: DemoService;
  const ai = { processDemo: jest.fn() };
  const userIds: string[] = [];
  const ADMIN = 'ops@example.com';

  beforeAll(async () => {
    env = validateEnv({
      ...INTEGRATION_ENV,
      LLM_DAILY_BUDGET_USD: '10',
      DEMO_API_KEY: 'd'.repeat(20),
      DEMO_SERVICE_TOKEN: 't'.repeat(20),
      DEMO_DAILY_BUDGET_USD: '0.05',
      DEMO_RL_PER_HOUR: '50',
      TURNSTILE_SKIP: 'true',
    });
    prepareTestDatabase(env.DATABASE_URL);
    prisma = new PrismaService(env);
    redis = new RedisService(env);
    storage = new StorageService(env);
    const metrics = new MetricsService();
    budget = new BudgetService(redis, metrics, env, logger);
    audit = new AuditService(prisma);
    dlq = new DlqService(redis, metrics, logger);
    admin = new AdminService(
      prisma,
      audit,
      storage,
      budget,
      new DlqAdminService(dlq, redis, audit),
    );
    demo = new DemoService(
      env,
      new RedisWindowStore(redis),
      new DemoCacheService(),
      budget,
      new TurnstileService(env, logger),
      storage,
      ai as unknown as AiClient,
      metrics,
      logger,
    );
    for (const key of await redis.client.keys('budget:*')) await redis.client.del(key);
    for (const key of await redis.client.keys('demo:*')) await redis.client.del(key);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { action: { startsWith: 'admin_' } } });
    await prisma.auditLog.deleteMany({
      where: { action: 'emergency_detected', userId: { in: userIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await dlq.onModuleDestroy();
    await prisma.onModuleDestroy();
    await redis.onModuleDestroy();
  });

  async function seedDocument(opts: { status: 'needs_review' | 'done'; confidence: number }) {
    const user = await prisma.user.create({
      data: {
        waPhoneHash: `hash-${randomUUID()}`,
        waPhoneEnc: 'enc:PHONE-9876543210-SECRET',
        lastInboundAt: new Date(),
      },
    });
    userIds.push(user.id);
    const message = await prisma.message.create({
      data: {
        userId: user.id,
        direction: 'in',
        waMessageId: `wamid.${randomUUID()}`,
        type: 'image',
      },
    });
    const s3Key = `media/${user.id}/2026/11/${message.id}.jpg`;
    const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    await storage.putStream({ key: s3Key, body: Readable.from(jpeg), contentType: 'image/jpeg' });
    const document = await prisma.document.create({
      data: {
        userId: user.id,
        messageId: message.id,
        kind: 'prescription',
        s3Key,
        status: opts.status,
        overallConfidence: opts.confidence,
        promptVersion: 'rx_extract_v1',
        extraction: {
          kind: 'prescription',
          medicines: [
            { low_confidence: true, name: { value: 'Hidden Medicine', confidence: 0.2 } },
          ],
        },
      },
    });
    return { user, document, s3Key };
  }

  describe('admin', () => {
    it('stats: every query runs on real data and counts what was seeded', async () => {
      const { user } = await seedDocument({ status: 'needs_review', confidence: 0.4 });
      await prisma.auditLog.create({
        data: {
          actor: 'system',
          userId: user.id,
          action: 'emergency_detected',
          metadata: { category: 'chest_pain' },
        },
      });
      const stats = await admin.stats('7d');
      expect(stats.users.total).toBeGreaterThanOrEqual(1);
      expect(stats.users.new).toBeGreaterThanOrEqual(1);
      expect(stats.users.active7d).toBeGreaterThanOrEqual(1);
      expect(stats.needsReview).toBeGreaterThanOrEqual(1);
      expect(stats.documentsByDay.some((row) => row.kind === 'prescription' && row.n >= 1)).toBe(
        true,
      );
      expect(
        stats.emergenciesByCategory.find((row) => row.category === 'chest_pain')?.n,
      ).toBeGreaterThanOrEqual(1);
      expect(stats.costByDay).toHaveLength(7);
      expect(stats.budget.state).toBe('normal');
      expect(JSON.stringify(stats)).not.toMatch(/wa_phone|PHONE-9876543210|hash-/);
    });

    it('review queue shows the document without values, reveal audits and links, resolve removes it', async () => {
      const { document, user, s3Key } = await seedDocument({
        status: 'needs_review',
        confidence: 0.4,
      });

      const page = await admin.reviewQueue({ limit: 100, includeReviewed: false });
      const item = page.items.find((row) => row.id === document.id);
      expect(item).toMatchObject({ userId: user.id, warnings: { lowConfidenceItems: 1 } });
      expect(JSON.stringify(page)).not.toContain('Hidden Medicine');
      expect(JSON.stringify(page)).not.toMatch(/PHONE-9876543210|wa_phone|media\//);

      const revealed = await admin.reveal(
        document.id,
        ADMIN,
        'Checking the user-reported wrong dose',
      );
      expect(JSON.stringify(revealed.extraction)).toContain('Hidden Medicine');
      expect(revealed.imageUrl).toContain('X-Amz-Expires=60');
      const image = await fetch(revealed.imageUrl);
      expect(image.status).toBe(200);
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
      expect(JSON.stringify(revealed)).not.toMatch(/PHONE-9876543210|wa_phone/);

      const rows = await prisma.auditLog.findMany({
        where: { action: 'admin_reveal', userId: user.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe('admin');
      expect(rows[0]?.metadata).toMatchObject({
        admin_email: ADMIN,
        document_id: document.id,
        reason: 'Checking the user-reported wrong dose',
      });

      await admin.resolve(document.id, ADMIN, 'extraction_wrong');
      const saved = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
      expect(saved).toMatchObject({ reviewLabel: 'extraction_wrong' });
      expect(saved.reviewedAt).not.toBeNull();
      expect(saved.reviewedByHash).toMatch(/^[0-9a-f]{64}$/);
      const after = await admin.reviewQueue({ limit: 100, includeReviewed: false });
      expect(after.items.some((row) => row.id === document.id)).toBe(false);
      const withReviewed = await admin.reviewQueue({ limit: 100, includeReviewed: true });
      expect(withReviewed.items.some((row) => row.id === document.id)).toBe(true);
      await storage.deleteObject(s3Key);
    });

    it('a document with high confidence is not in the queue; a low-confidence "done" one is', async () => {
      const high = await seedDocument({ status: 'done', confidence: 0.95 });
      const low = await seedDocument({ status: 'done', confidence: 0.5 });
      const ids = (await admin.reviewQueue({ limit: 100, includeReviewed: false })).items.map(
        (r) => r.id,
      );
      expect(ids).toContain(low.document.id);
      expect(ids).not.toContain(high.document.id);
    });

    it('cursor pagination walks the whole queue without repeats', async () => {
      for (let i = 0; i < 3; i++) await seedDocument({ status: 'needs_review', confidence: 0.3 });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await admin.reviewQueue({
          limit: 2,
          includeReviewed: true,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map((row) => row.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeGreaterThanOrEqual(3);
    });

    it('lists the dead-letter queues', async () => {
      const overview = await admin.dlqOverview();
      expect(overview.queues.map((q) => q.queue)).toEqual(
        expect.arrayContaining(['inbound', 'outbound', 'user-deletion']),
      );
    });
  });

  describe('demo', () => {
    const png = (): Promise<Buffer> =>
      sharp({ create: { width: 30, height: 30, channels: 3, background: '#fff' } })
        .png()
        .toBuffer();
    const answer = (cost: number) => ({
      request_id: 'r',
      intent: 'prescription',
      emergency: false,
      warnings: [],
      reply: { language: 'en', text: 'ok', buttons: [] },
      meta: { prompt_version: 'v', latency_ms: 5, cost_usd: cost },
      debug_trace: [{ node: 'classify', latency_ms: 3, status: 'ok' }],
    });

    it('writes nothing to the user tables, deletes the upload and counts the demo budget apart', async () => {
      ai.processDemo.mockResolvedValue(answer(0.02));
      const counts = async () => ({
        documents: await prisma.document.count(),
        messages: await prisma.message.count(),
        medications: await prisma.medication.count(),
        users: await prisma.user.count(),
      });
      const before = await counts();
      const mainBefore = await redis.client.get(`budget:day:${budgetDay()}`);

      const result = await demo.upload({
        file: await png(),
        language: 'en',
        turnstileToken: undefined,
        ipHash: `ip-${randomUUID()}`,
      });

      expect(result.cached).toBe(false);
      expect(await counts()).toEqual(before);
      const request = ai.processDemo.mock.calls.at(-1)?.[0] as {
        input: { media_url: string };
        options: { include_trace: boolean };
      };
      expect(request.options.include_trace).toBe(true);
      const key = new URL(request.input.media_url).pathname.split('/').slice(2).join('/');
      expect(key.startsWith('demo/')).toBe(true);
      expect(await storage.statObject(key)).toBeUndefined();
      expect(Number(await redis.client.get(`budget:demo:${budgetDay()}`))).toBeGreaterThanOrEqual(
        20_000,
      );
      expect(await redis.client.get(`budget:day:${budgetDay()}`)).toBe(mainBefore);
    });

    it('refuses uploads once the demo budget is spent, with no model call', async () => {
      await redis.client.set(`budget:demo:${budgetDay()}`, String(60_000));
      ai.processDemo.mockClear();
      await expect(
        demo.upload({ file: await png(), language: 'hi', turnstileToken: undefined, ipHash: 'x' }),
      ).rejects.toMatchObject({ code: 'budget_exhausted' });
      expect(ai.processDemo).not.toHaveBeenCalled();
      expect(await demo.uploadsEnabled()).toBe(false);
      await redis.client.del(`budget:demo:${budgetDay()}`);
    });
  });
});
