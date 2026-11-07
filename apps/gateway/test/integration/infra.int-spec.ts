/**
 * Integration test against REAL Postgres, Redis and MinIO (no mocks).
 *
 *   make test-integration            (starts docker-compose.test.yml on ports 5543/6479/9100)
 *   pnpm --filter @dawai/gateway test:integration   (with the stack already running / CI services)
 *
 * Connection settings come from the environment and fall back to the test stack. As a safety net the
 * suite refuses to run unless the database name ends with "_test", so it can never touch dev data.
 */
import { randomUUID } from 'node:crypto';

import { validateEnv, type Env } from '../../src/config/env.schema';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { ReadinessService } from '../../src/health/readiness.service';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';

const raw = { ...INTEGRATION_ENV };

describe('infrastructure (integration)', () => {
  let env: Env;
  let prisma: PrismaService;
  let redis: RedisService;
  let storage: StorageService;

  beforeAll(() => {
    env = validateEnv(raw);
    prepareTestDatabase(env.DATABASE_URL);

    prisma = new PrismaService(env);
    redis = new RedisService(env);
    storage = new StorageService(env);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await redis.onModuleDestroy();
    storage.onModuleDestroy();
  });

  describe('postgres', () => {
    const createdUserIds: string[] = [];
    const newUser = async (): Promise<string> => {
      const user = await prisma.user.create({
        data: { waPhoneHash: `hash-${randomUUID()}`, waPhoneEnc: 'enc:test' },
      });
      createdUserIds.push(user.id);
      return user.id;
    };

    afterEach(async () => {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds.splice(0) } } });
    });

    it('inserts and reads a user row with DB-generated id and defaults', async () => {
      const hash = `hash-${randomUUID()}`;
      const created = await prisma.user.create({
        data: { waPhoneHash: hash, waPhoneEnc: 'enc:x' },
      });
      createdUserIds.push(created.id);

      const found = await prisma.user.findUnique({ where: { waPhoneHash: hash } });
      expect(found).toMatchObject({
        id: created.id,
        waPhoneEnc: 'enc:x',
        language: 'hi',
        consentAt: null,
        deletedAt: null,
      });
      expect(found?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(found?.createdAt).toBeInstanceOf(Date);
    });

    it('enforces unique phone hash', async () => {
      const hash = `hash-${randomUUID()}`;
      const first = await prisma.user.create({ data: { waPhoneHash: hash, waPhoneEnc: 'a' } });
      createdUserIds.push(first.id);
      await expect(
        prisma.user.create({ data: { waPhoneHash: hash, waPhoneEnc: 'b' } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('DELETE of a user cascades to everything they own, but keeps the audit row', async () => {
      const userId = await newUser();
      const message = await prisma.message.create({
        data: {
          userId,
          direction: 'in',
          waMessageId: `wamid.${randomUUID()}`,
          type: 'image',
        },
      });
      const document = await prisma.document.create({
        data: { userId, messageId: message.id, s3Key: `docs/${randomUUID()}.jpg` },
      });
      const medication = await prisma.medication.create({
        data: {
          userId,
          documentId: document.id,
          rawName: 'Dolo 650',
          frequencyPerDay: 2,
          timings: ['08:00', '20:00'],
          startDate: new Date('2026-11-07'),
          confidence: 0.9,
        },
      });
      await prisma.reminder.create({
        data: { medicationId: medication.id, userId, scheduledAt: new Date() },
      });
      await prisma.caregiver.create({
        data: { userId, waPhoneEnc: 'enc', waPhoneHash: `cg-${randomUUID()}`, relation: 'son' },
      });
      const audit = await prisma.auditLog.create({
        data: { actor: 'system', userId, action: 'user_deleted', metadata: { reason: 'test' } },
      });

      await prisma.user.delete({ where: { id: userId } });

      const remaining = await Promise.all([
        prisma.message.count({ where: { userId } }),
        prisma.document.count({ where: { userId } }),
        prisma.medication.count({ where: { userId } }),
        prisma.reminder.count({ where: { userId } }),
        prisma.caregiver.count({ where: { userId } }),
      ]);
      expect(remaining).toEqual([0, 0, 0, 0, 0]);
      // audit_logs has no FK on purpose: DPDP erasure keeps one anonymous record.
      await expect(prisma.auditLog.findUnique({ where: { id: audit.id } })).resolves.not.toBeNull();
      await prisma.auditLog.delete({ where: { id: audit.id } });
    });

    it('rejects interaction pairs stored in the wrong order (salt_a < salt_b)', async () => {
      await expect(
        prisma.interaction.create({
          data: {
            saltA: 'warfarin',
            saltB: 'aspirin',
            severity: 'major',
            summary: 't',
            source: 't',
          },
        }),
      ).rejects.toThrow(/interactions_salt_order_check|check constraint/i);
    });

    it('serves fuzzy brand-name search through the trigram index', async () => {
      const tag = randomUUID().slice(0, 8);
      const drug = await prisma.drug.create({
        data: {
          brandName: `Dolo650${tag}`,
          saltComposition: 'paracetamol',
          strength: '650 mg',
          form: 'tablet',
          source: 'integration-test',
        },
      });
      try {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id::text FROM drugs
          WHERE brand_name % ${`Dolo 650 ${tag}`} OR brand_name ILIKE ${`dolo650${tag}%`}`;
        expect(rows.map((row) => row.id)).toContain(drug.id);
      } finally {
        await prisma.drug.delete({ where: { id: drug.id } });
      }
    });

    it('has pg_trgm and pgcrypto installed', async () => {
      const rows = await prisma.$queryRaw<{ extname: string }[]>`
        SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'pgcrypto')`;
      expect(rows.map((row) => row.extname).sort()).toEqual(['pg_trgm', 'pgcrypto']);
    });
  });

  describe('redis', () => {
    it('answers PING and round-trips a value', async () => {
      await expect(redis.healthCheck()).resolves.toBeUndefined();
      const key = `it:${randomUUID()}`;
      await redis.client.set(key, 'hello', 'EX', 30);
      await expect(redis.client.get(key)).resolves.toBe('hello');
      await redis.client.del(key);
    });

    it('hands out independent connections for BullMQ (maxRetriesPerRequest: null)', async () => {
      const connection = redis.createConnection({ maxRetriesPerRequest: null });
      await expect(connection.ping()).resolves.toBe('PONG');
      expect(connection).not.toBe(redis.client);
    });
  });

  describe('minio (S3)', () => {
    it('HeadBucket succeeds for the existing bucket', async () => {
      await expect(storage.healthCheck()).resolves.toBeUndefined();
    });

    it('HeadBucket fails for a missing bucket', async () => {
      const other = new StorageService({
        ...env,
        S3_BUCKET: `missing-${randomUUID().slice(0, 8)}`,
      });
      try {
        await expect(other.healthCheck()).rejects.toThrow();
      } finally {
        other.onModuleDestroy();
      }
    });
  });

  it('readiness reports all three dependencies ok', async () => {
    const readiness = new ReadinessService(prisma, redis, storage);
    await expect(readiness.check()).resolves.toEqual({
      status: 'ok',
      checks: { db: 'ok', redis: 'ok', s3: 'ok' },
    });
  });
});
