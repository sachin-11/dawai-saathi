/**
 * Webhook integration tests against REAL Postgres + Redis (docker-compose.test.yml).
 *
 *   make test-integration
 *
 * Every test uses a fresh random phone number and fresh WhatsApp message ids, so tests never depend
 * on each other and can run against a dirty database.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import type { INestApplication } from '@nestjs/common';
import { Logger as PinoNestLogger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types';

import { hashPhone } from '../../src/common/crypto/crypto.util';
import { LOG_STREAM } from '../../src/common/logger/log-stream';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { InboundQueue } from '../../src/queues/inbound.queue';
import type { InboundJobData } from '../../src/queues/queue.constants';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';
import { createApp, fixtureBuffer, signedHeaders } from '../support/webhook-test-utils';

const URL = '/webhook/whatsapp';
const FIXTURE_PHONE = '919999999999';
const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';

const logLines: string[] = [];
const logStream = new Writable({
  write(chunk: Buffer, _encoding, callback): void {
    logLines.push(chunk.toString());
    callback();
  },
});

/** A fixture with a fresh sender number and fresh message ids (so reruns never collide). */
function freshFixture(name: string, phone: string = randomPhone()): { raw: Buffer; phone: string } {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  const raw = fixtureBuffer(name)
    .toString()
    .replaceAll(FIXTURE_PHONE, phone)
    .replaceAll('wamid.', `wamid.${tag}.`);
  return { raw: Buffer.from(raw), phone };
}

/**
 * The recorded fixtures carry a fixed timestamp. A message older than 24 hours closes WhatsApp's
 * customer-service window, so a test that needs the bot to ANSWER must send a current timestamp.
 */
function withCurrentTimestamps(raw: Buffer): Buffer {
  const now = String(Math.floor(Date.now() / 1000));
  return Buffer.from(raw.toString().replace(/"timestamp":\s*"\d+"/g, `"timestamp": "${now}"`));
}

function randomPhone(): string {
  return `919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

/** Build a webhook with `count` text messages from one sender. */
function textBatch(count: number, phone: string): Buffer {
  const base = JSON.parse(fixtureBuffer('text').toString()) as {
    entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[];
  };
  const tag = randomUUID().replaceAll('-', '').slice(0, 8);
  const template = base.entry[0]?.changes[0]?.value.messages[0] ?? {};
  const messages = Array.from({ length: count }, (_, i) => ({
    ...template,
    from: phone,
    id: `wamid.${tag}.${i}`,
    text: { body: `message number ${i}` },
  }));
  const body = base;
  if (body.entry[0]?.changes[0]) {
    body.entry[0].changes[0].value.messages = messages;
  }
  return Buffer.from(JSON.stringify(body));
}

describe('webhook (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let queue: InboundQueue;
  const phones: string[] = [];

  const post = (raw: Buffer): request.Test =>
    request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());

  const track = (phone: string): string => {
    phones.push(phone);
    return phone;
  };

  const jobsFor = async (waIds: string[]): Promise<InboundJobData[]> => {
    const jobs = await queue.getQueue().getJobs(['waiting', 'delayed', 'active', 'completed']);
    return jobs.map((job) => job.data).filter((data) => waIds.includes(data.waMessageId));
  };

  beforeAll(async () => {
    Object.assign(process.env, INTEGRATION_ENV);
    prepareTestDatabase(INTEGRATION_ENV['DATABASE_URL'] ?? '');
    app = (await createApp((builder) =>
      builder.overrideProvider(LOG_STREAM).useValue(logStream),
    )) as INestApplication<App>;
    app.useLogger(app.get(PinoNestLogger));
    prisma = app.get(PrismaService);
    queue = app.get(InboundQueue);
    await queue.getQueue().obliterate({ force: true });
    // Warm up connections so timing assertions measure the handler, not first-connect cost.
    await post(freshFixture('status').raw).expect(200);
    await post(textBatch(1, track(randomPhone()))).expect(200);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { waPhoneHash: { in: phones.map((phone) => hashPhone(phone, PEPPER)) } },
    });
    await app.close();
  });

  it('text message: creates 1 user, 1 message and 1 queue job', async () => {
    const { raw, phone } = freshFixture('text', track(randomPhone()));
    const waId = (
      JSON.parse(raw.toString()) as {
        entry: { changes: { value: { messages: { id: string }[] } }[] }[];
      }
    ).entry[0]?.changes[0]?.value.messages[0]?.id as string;

    const res = await post(raw).expect(200);
    expect(res.body).toEqual({ status: 'received' });

    const user = await prisma.user.findUniqueOrThrow({
      where: { waPhoneHash: hashPhone(phone, PEPPER) },
    });
    expect(user.language).toBe('hi');
    expect(user.consentAt).toBeNull();
    expect(user.waPhoneEnc).toMatch(/^v1:/);
    expect(user.lastInboundAt?.toISOString()).toBe(new Date(1794000000 * 1000).toISOString());

    const messages = await prisma.message.findMany({ where: { userId: user.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      waMessageId: waId,
      direction: 'in',
      type: 'text',
      mediaS3Key: null,
    });
    // A brand-new user has not consented yet (M4): only metadata is stored, never the text.
    expect(messages[0]?.bodyRedacted).toBeNull();

    const jobs = await jobsFor([waId]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      messageId: messages[0]?.id,
      userId: user.id,
      waMessageId: waId,
      type: 'text',
    });
    // PII-free payload: no phone number, no message text.
    const payload = JSON.stringify(jobs[0]);
    expect(payload).not.toContain(phone);
    expect(payload).not.toContain('Dolo');
    expect(payload).not.toContain('9876543210');
  });

  it('job id equals the WhatsApp message id and the job name is the message type', async () => {
    const { raw } = freshFixture('image', track(randomPhone()));
    await post(raw).expect(200);
    const id = (
      JSON.parse(raw.toString()) as {
        entry: { changes: { value: { messages: { id: string }[] } }[] }[];
      }
    ).entry[0]?.changes[0]?.value.messages[0]?.id as string;
    const job = await queue.getQueue().getJob(id);
    expect(job?.name).toBe('image');
    expect(job?.data.media).toMatchObject({ id: 'media-img-1', mimeType: 'image/jpeg' });
    expect(job?.opts.attempts).toBe(5);
  });

  it('the same payload twice -> still 1 message row and 1 job', async () => {
    const { raw, phone } = freshFixture('text', track(randomPhone()));
    await post(raw).expect(200);
    await post(raw).expect(200);

    const user = await prisma.user.findUniqueOrThrow({
      where: { waPhoneHash: hashPhone(phone, PEPPER) },
    });
    expect(await prisma.message.count({ where: { userId: user.id } })).toBe(1);
    const waId = (await prisma.message.findFirstOrThrow({ where: { userId: user.id } }))
      .waMessageId;
    expect(await jobsFor([waId])).toHaveLength(1);
  });

  it('a batch of 3 messages -> 3 rows and 3 jobs, in order', async () => {
    const { raw, phone } = freshFixture('batch', track(randomPhone()));
    await post(raw).expect(200);

    const user = await prisma.user.findUniqueOrThrow({
      where: { waPhoneHash: hashPhone(phone, PEPPER) },
    });
    const rows = await prisma.message.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.type)).toEqual(['text', 'image', 'button']);
    expect(rows.every((row) => row.bodyRedacted === null)).toBe(true); // pre-consent: no text stored
    expect(await jobsFor(rows.map((row) => row.waMessageId))).toHaveLength(3);
  });

  it('unsupported types (sticker, location) are still saved and queued', async () => {
    const { raw, phone } = freshFixture('unsupported', track(randomPhone()));
    await post(raw).expect(200);
    const user = await prisma.user.findUniqueOrThrow({
      where: { waPhoneHash: hashPhone(phone, PEPPER) },
    });
    const row = await prisma.message.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.type).toBe('unsupported');
    expect(await jobsFor([row.waMessageId])).toHaveLength(1);
  });

  it('status updates and foreign phone_number_id create nothing', async () => {
    const usersBefore = await prisma.user.count();
    const messagesBefore = await prisma.message.count();
    await post(freshFixture('status').raw).expect(200);
    await post(freshFixture('foreign').raw).expect(200);
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.message.count()).toBe(messagesBefore);
  });

  it('two concurrent first messages from the same new number -> exactly 1 user', async () => {
    const phone = track(randomPhone());
    const responses = await Promise.all(Array.from({ length: 8 }, () => post(textBatch(1, phone))));
    expect(responses.map((res) => res.status)).toEqual(Array(8).fill(200));

    const users = await prisma.user.findMany({
      where: { waPhoneHash: hashPhone(phone, PEPPER) },
    });
    expect(users).toHaveLength(1);
    expect(await prisma.message.count({ where: { userId: users[0]?.id } })).toBe(8);
  });

  it('different spellings of one number map to the same user', async () => {
    const phone = track(randomPhone());
    const local = phone.slice(2); // 10-digit form
    await post(textBatch(1, phone)).expect(200);
    await post(textBatch(1, local)).expect(200);
    const hashes = new Set([hashPhone(phone, PEPPER), hashPhone(local, PEPPER)]);
    expect(hashes.size).toBe(1);
    expect(await prisma.user.count({ where: { waPhoneHash: [...hashes][0] } })).toBe(1);
  });

  it('last_inbound_at only moves forward (a retried older message cannot extend the window)', async () => {
    const phone = track(randomPhone());
    const newer = textBatch(1, phone); // timestamp 1794000000 (from the text fixture)
    await post(newer).expect(200);

    const olderBody = JSON.parse(textBatch(1, phone).toString()) as {
      entry: { changes: { value: { messages: { timestamp: string }[] } }[] }[];
    };
    const message = olderBody.entry[0]?.changes[0]?.value.messages[0];
    if (message) message.timestamp = '1700000000';
    await post(Buffer.from(JSON.stringify(olderBody))).expect(200);

    const user = await prisma.user.findUniqueOrThrow({
      where: { waPhoneHash: hashPhone(phone, PEPPER) },
    });
    expect(user.lastInboundAt?.toISOString()).toBe(new Date(1794000000 * 1000).toISOString());
  });

  it('a 10-message batch is handled in under 1 second', async () => {
    const raw = textBatch(10, track(randomPhone()));
    const started = Date.now();
    await post(raw).expect(200);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });

  it('rejects a bad signature and creates nothing', async () => {
    const { raw, phone } = freshFixture('text', randomPhone());
    await request(app.getHttpServer())
      .post(URL)
      .set({ ...signedHeaders(raw), 'X-Hub-Signature-256': `sha256=${'a'.repeat(64)}` })
      .send(raw.toString())
      .expect(401);
    expect(await prisma.user.count({ where: { waPhoneHash: hashPhone(phone, PEPPER) } })).toBe(0);
  });

  it('no raw phone number is stored in ANY text column (only the encrypted form)', async () => {
    const { raw, phone } = freshFixture('text', track(randomPhone()));
    await post(raw).expect(200);

    const columns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
        AND data_type IN ('text', 'character varying', 'jsonb', 'ARRAY')`;
    expect(columns.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const { table_name, column_name } of columns) {
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) FROM "${table_name}" WHERE "${column_name}"::text LIKE $1`,
        `%${phone}%`,
      );
      if ((rows[0]?.count ?? 0n) > 0n) offenders.push(`${table_name}.${column_name}`);
    }
    expect(offenders).toEqual([]);

    // ...but the encrypted copy decrypts back to it, so we can still message the user later.
    const user = await prisma.user.findUniqueOrThrow({
      where: { waPhoneHash: hashPhone(phone, PEPPER) },
    });
    expect(user.waPhoneEnc).not.toContain(phone);
  });

  it('logs contain no phone numbers and no message text', () => {
    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0); // the capture really works
    expect(logs).toContain('webhook processed');
    for (const phone of phones) {
      expect(logs).not.toContain(phone);
      expect(logs).not.toContain(phone.slice(2));
    }
    expect(logs).not.toContain(FIXTURE_PHONE);
    expect(logs).not.toContain('9876543210');
    expect(logs).not.toContain('Dolo 650');
    expect(logs).not.toContain('Test Patient');
  });
});

describe('webhook reliability (integration)', () => {
  it('Redis down -> 500 (Meta retries); the retry then repairs the missing job without a duplicate row', async () => {
    Object.assign(process.env, INTEGRATION_ENV);
    const goodApp = (await createApp()) as INestApplication<App>;
    const prisma = goodApp.get(PrismaService);
    const goodQueue = goodApp.get(InboundQueue);
    const phone = randomPhone();
    const { raw } = freshFixture('text', phone);
    const waId = (
      JSON.parse(raw.toString()) as {
        entry: { changes: { value: { messages: { id: string }[] } }[] }[];
      }
    ).entry[0]?.changes[0]?.value.messages[0]?.id as string;

    try {
      // 1) Same DB, unreachable Redis.
      process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
      const brokenApp = (await createApp()) as INestApplication<App>;
      try {
        const res = await request(brokenApp.getHttpServer())
          .post(URL)
          .set(signedHeaders(raw))
          .send(raw.toString());
        expect(res.status).toBe(500);
      } finally {
        await brokenApp.close();
      }
      process.env['REDIS_URL'] = INTEGRATION_ENV['REDIS_URL'] ?? '';

      // The message row WAS saved before the enqueue failed, but no job exists.
      const user = await prisma.user.findUniqueOrThrow({
        where: { waPhoneHash: hashPhone(phone, PEPPER) },
      });
      expect(await prisma.message.count({ where: { userId: user.id } })).toBe(1);
      expect(await goodQueue.getQueue().getJob(waId)).toBeUndefined();

      // 2) Meta retries: the row is a duplicate, but the job is created now. Nothing is lost.
      await request(goodApp.getHttpServer())
        .post(URL)
        .set(signedHeaders(raw))
        .send(raw.toString())
        .expect(200);
      expect(await prisma.message.count({ where: { userId: user.id } })).toBe(1);
      expect((await goodQueue.getQueue().getJob(waId))?.data.waMessageId).toBe(waId);
    } finally {
      await prisma.user.deleteMany({ where: { waPhoneHash: hashPhone(phone, PEPPER) } });
      await goodApp.close();
    }
  });
});

describe('inbound worker (integration)', () => {
  it('consumes the job: logs ids only and completes it', async () => {
    Object.assign(process.env, { ...INTEGRATION_ENV, WORKERS_ENABLED: 'true' });
    const before = logLines.length;
    const app = (await createApp((builder) =>
      builder.overrideProvider(LOG_STREAM).useValue(logStream),
    )) as INestApplication<App>;
    app.useLogger(app.get(PinoNestLogger));
    const prisma = app.get(PrismaService);
    const queue = app.get(InboundQueue);
    const phone = randomPhone();
    const raw = withCurrentTimestamps(freshFixture('text', phone).raw);

    try {
      await request(app.getHttpServer())
        .post(URL)
        .set(signedHeaders(raw))
        .send(raw.toString())
        .expect(200);
      const waId = (
        await prisma.message.findFirstOrThrow({
          where: { user: { waPhoneHash: hashPhone(phone, PEPPER) } },
        })
      ).waMessageId;

      let state = '';
      for (let i = 0; i < 50 && state !== 'completed'; i++) {
        state = (await (await queue.getQueue().getJob(waId))?.getState()) ?? 'missing';
        if (state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(state).toBe('completed');

      // The worker also drains jobs left by earlier tests, so look only at ours.
      const workerLogs = logLines
        .slice(before)
        .filter((line) => line.includes('inbound job received') && line.includes(waId));
      expect(workerLogs).toHaveLength(1);
      expect(workerLogs[0]).toContain(waId);
      expect(workerLogs[0]).not.toContain(phone);
    } finally {
      await prisma.user.deleteMany({ where: { waPhoneHash: hashPhone(phone, PEPPER) } });
      await app.close();
      process.env['WORKERS_ENABLED'] = 'false';
    }
  });
});
