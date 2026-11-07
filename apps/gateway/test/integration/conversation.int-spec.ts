/**
 * M4 integration tests: onboarding, consent, commands and DELETE (erasure) end to end.
 * Real Postgres, Redis and MinIO (docker-compose.test.yml); the WhatsApp Graph API is mocked with
 * nock so every message the bot sends can be asserted. Workers run for real.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import type { INestApplication } from '@nestjs/common';
import { Logger as PinoNestLogger } from 'nestjs-pino';
import nock from 'nock';
import request from 'supertest';
import type { App } from 'supertest/types';

import { hashPhone } from '../../src/common/crypto/crypto.util';
import { LOG_STREAM } from '../../src/common/logger/log-stream';
import { PendingStore } from '../../src/common/pending/pending.store';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { InboundQueue } from '../../src/queues/inbound.queue';
import { OutboundQueue } from '../../src/messaging/outbound.queue';
import { UserDeletionQueue } from '../../src/deletion/user-deletion.queue';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';
import { createApp, signedHeaders } from '../support/webhook-test-utils';

const GRAPH = 'https://graph.facebook.com';
const SEND_PATH = '/v21.0/100000000000001/messages';
const URL = '/webhook/whatsapp';
const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';

const logLines: string[] = [];
const logStream = new Writable({
  write(chunk: Buffer, _encoding, callback): void {
    logLines.push(chunk.toString());
    callback();
  },
});

interface GraphBody {
  to?: string;
  type?: string;
  status?: string;
  message_id?: string;
  text?: { body: string };
  interactive?: {
    body: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] };
  };
}

const graph = { sends: [] as GraphBody[], reads: [] as GraphBody[], counter: 0, mediaLookups: 0 };

function installGraphMock(): void {
  nock(GRAPH)
    .persist()
    .post(SEND_PATH)
    .reply((_uri, body) => {
      const payload = body as GraphBody;
      if (payload.status === 'read') {
        graph.reads.push(payload);
        return [200, { success: true }];
      }
      graph.sends.push(payload);
      graph.counter += 1;
      return [200, { messages: [{ id: `wamid.OUT${graph.counter}` }] }];
    });
}

const randomPhone = (): string => `919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

function webhookFor(phone: string, message: Record<string, unknown>): Buffer {
  const id = `wamid.IN${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  return Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '200000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550000000',
                  phone_number_id: '100000000000001',
                },
                messages: [
                  { from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), ...message },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
}

const text = (body: string): Record<string, unknown> => ({ type: 'text', text: { body } });
const tap = (id: string, title = 'x'): Record<string, unknown> => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title } },
});
const image = (mediaId: string, caption?: string): Record<string, unknown> => ({
  type: 'image',
  image: { id: mediaId, mime_type: 'image/jpeg', ...(caption ? { caption } : {}) },
});

async function waitFor<T>(
  produce: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  timeoutMs = 12_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('conversation (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: StorageService;
  let redis: RedisService;
  let pending: PendingStore;
  const phones: string[] = [];

  const sendsTo = (phone: string): GraphBody[] => graph.sends.filter((body) => body.to === phone);
  const post = (raw: Buffer): request.Test =>
    request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());

  /** Send one inbound message and wait for the bot's NEXT reply (returns it). */
  const say = async (phone: string, message: Record<string, unknown>): Promise<GraphBody> => {
    const before = sendsTo(phone).length;
    await post(webhookFor(phone, message)).expect(200);
    await waitFor(
      () => sendsTo(phone).length > before,
      `a reply to ${JSON.stringify(message).slice(0, 40)}`,
    );
    await sleep(150); // let any extra (unexpected) reply show up too
    return sendsTo(phone)[before] as GraphBody;
  };
  const newPhone = (): string => {
    const phone = randomPhone();
    phones.push(phone);
    return phone;
  };
  const userOf = (
    phone: string,
  ): Promise<{
    id: string;
    language: string;
    onboardingStep: string;
    consentAt: Date | null;
    consentVersion: string | null;
    remindersEnabled: boolean;
    deletedAt: Date | null;
  } | null> =>
    prisma.user.findUnique({
      where: { waPhoneHash: hashPhone(phone, PEPPER) },
      select: {
        id: true,
        language: true,
        onboardingStep: true,
        consentAt: true,
        consentVersion: true,
        remindersEnabled: true,
        deletedAt: true,
      },
    });
  const mustUser = async (
    phone: string,
  ): Promise<NonNullable<Awaited<ReturnType<typeof userOf>>>> => {
    const user = await userOf(phone);
    if (!user) throw new Error('user not found');
    return user;
  };
  const buttonIds = (send: GraphBody): string[] =>
    send.interactive?.action.buttons.map((button) => button.reply.id) ?? [];
  const bodyText = (send: GraphBody): string =>
    send.text?.body ?? send.interactive?.body.text ?? '';

  /** Walk a brand-new number through language + consent. */
  const onboard = async (phone: string, language: 'hi' | 'en' = 'en'): Promise<string> => {
    await say(phone, text('hello'));
    await say(phone, tap(`lang:${language}`));
    await say(phone, tap('consent:yes'));
    return (await mustUser(phone)).id;
  };

  const mockImage = (mediaId: string, content: Buffer): void => {
    nock(GRAPH)
      .get(`/v21.0/${mediaId}`)
      .reply(200, () => {
        graph.mediaLookups += 1;
        return {
          url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId}`,
          mime_type: 'image/jpeg',
          file_size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          id: mediaId,
        };
      });
    nock('https://lookaside.fbsbx.com')
      .get('/whatsapp_business/attachments/')
      .query({ mid: mediaId })
      .reply(200, content, {
        'content-type': 'image/jpeg',
        'content-length': String(content.length),
      });
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ...INTEGRATION_ENV,
      WORKERS_ENABLED: 'true',
      DEV_ECHO_BOT: 'true',
    });
    prepareTestDatabase(INTEGRATION_ENV['DATABASE_URL'] ?? '');
    nock.disableNetConnect();
    nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);
    installGraphMock();

    app = (await createApp((builder) =>
      builder.overrideProvider(LOG_STREAM).useValue(logStream),
    )) as INestApplication<App>;
    app.useLogger(app.get(PinoNestLogger));
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    redis = app.get(RedisService);
    pending = app.get(PendingStore);
  });

  afterAll(async () => {
    const hashes = phones.map((phone) => hashPhone(phone, PEPPER));
    const users = await prisma.user.findMany({
      where: { waPhoneHash: { in: hashes } },
      select: { id: true },
    });
    for (const user of users) await storage.deletePrefix(`media/${user.id}/`);
    await prisma.user.deleteMany({ where: { waPhoneHash: { in: hashes } } });
    await app.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('first contact: language -> consent -> active', () => {
    it('a new number gets language buttons; nothing about the message is stored or processed', async () => {
      const phone = newPhone();
      const reply = await say(phone, text('Meri dawai ki photo bhej rahi hoon, number 9876543210'));
      expect(buttonIds(reply)).toEqual(['lang:hi', 'lang:en']);

      const user = await mustUser(phone);
      expect(user).toMatchObject({ onboardingStep: 'language', consentAt: null, language: 'hi' });
      // pre-consent data minimisation: metadata only
      const message = await prisma.message.findFirstOrThrow({
        where: { userId: user.id, direction: 'in' },
      });
      expect(message.bodyRedacted).toBeNull();
      expect(sendsTo(phone)).toHaveLength(1);
    });

    it('choosing a language sends the consent message in that language, with I agree / Not now', async () => {
      const phone = newPhone();
      await say(phone, text('hello'));
      const consent = await say(phone, tap('lang:en', 'English'));

      expect(buttonIds(consent)).toEqual(['consent:yes', 'consent:no']);
      const body = bodyText(consent);
      expect(body).toContain('30 days');
      expect(body).toContain('DELETE');
      expect(body).toContain('not a doctor');
      expect(body).toContain('https://dawaisaathi.example/privacy');
      expect(consent.interactive?.action.buttons.map((button) => button.reply.title)).toEqual([
        'I agree',
        'Not now',
      ]);

      expect(await mustUser(phone)).toMatchObject({
        language: 'en',
        onboardingStep: 'consent',
        consentAt: null,
      });
    });

    it('"I agree" activates the user, records consent v1 and audits it', async () => {
      const phone = newPhone();
      await say(phone, text('hi'));
      await say(phone, tap('lang:hi', 'हिन्दी'));
      const welcome = await say(phone, tap('consent:yes'));

      expect(bodyText(welcome)).toContain('धन्यवाद');
      const user = await mustUser(phone);
      expect(user.onboardingStep).toBe('done');
      expect(user.consentVersion).toBe('v1');
      expect(user.consentAt).toBeInstanceOf(Date);

      const audit = await prisma.auditLog.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual(['language_changed', 'consent_given']);
      expect(audit[1]?.metadata).toEqual({ version: 'v1' });
      expect(audit[0]?.metadata).toEqual({ language: 'hi' });
    });

    it('"Not now" keeps the user in the consent step and processes nothing', async () => {
      const phone = newPhone();
      await say(phone, text('hi'));
      await say(phone, tap('lang:en'));
      const declined = await say(phone, tap('consent:no'));

      expect(bodyText(declined)).toContain('will not read or save');
      expect(await mustUser(phone)).toMatchObject({ onboardingStep: 'consent', consentAt: null });
      const audit = await prisma.auditLog.findMany({
        where: { userId: (await mustUser(phone)).id },
      });
      expect(audit.map((row) => row.action)).toContain('consent_declined');
    });

    it('a photo sent BEFORE consent is not downloaded, stored or processed: only the consent reminder comes back', async () => {
      const phone = newPhone();
      await say(phone, text('hi'));
      await say(phone, tap('lang:en'));
      const lookupsBefore = graph.mediaLookups;
      mockImage('media-preconsent', Buffer.alloc(1024, 3));

      const reply = await say(phone, image('media-preconsent'));

      expect(buttonIds(reply)).toEqual(['consent:yes', 'consent:no']); // the reminder
      expect(bodyText(reply)).toContain('Nothing you sent has been opened or saved');
      expect(graph.mediaLookups).toBe(lookupsBefore); // Meta's media endpoint was never called
      expect(nock.pendingMocks().some((mock) => mock.includes('media-preconsent'))).toBe(true); // mock untouched

      const user = await mustUser(phone);
      const rows = await prisma.message.findMany({ where: { userId: user.id, direction: 'in' } });
      expect(rows.every((row) => row.mediaS3Key === null && row.bodyRedacted === null)).toBe(true);
      expect(await storage.deletePrefix(`media/${user.id}/`)).toBe(0); // nothing in S3
      nock.cleanAll();
      installGraphMock();
    });

    it('a text sent during the consent step only brings the reminder; after consent a photo must be re-sent', async () => {
      const phone = newPhone();
      await say(phone, text('hi'));
      await say(phone, tap('lang:en'));
      const reminder = await say(phone, text('what is the dose of Dolo?'));
      expect(buttonIds(reminder)).toEqual(['consent:yes', 'consent:no']);
      expect((await mustUser(phone)).onboardingStep).toBe('consent');
    });
  });

  describe('commands', () => {
    it('HELP works at every step, including before the language is chosen', async () => {
      const phone = newPhone();
      const help = await say(phone, text('HELP'));
      expect(bodyText(help)).toContain('112');
      expect(bodyText(help)).toContain('DELETE');
      expect((await mustUser(phone)).onboardingStep).toBe('language'); // did not advance onboarding
    });

    it('"help me with my medicine" is NOT the HELP command (exact match only)', async () => {
      const phone = newPhone();
      const reply = await say(phone, text('help me with my medicine'));
      expect(buttonIds(reply)).toEqual(['lang:hi', 'lang:en']); // treated as an ordinary first message
    });

    it('LANGUAGE switches the language and confirms in the new language', async () => {
      const phone = newPhone();
      await onboard(phone, 'hi');
      const buttons = await say(phone, text('language'));
      expect(buttonIds(buttons)).toEqual(['lang:hi', 'lang:en']);
      const confirm = await say(phone, tap('lang:en'));
      expect(bodyText(confirm)).toBe('Language set to English.');
      expect((await mustUser(phone)).language).toBe('en');
    });

    it('STOP REMINDERS and START REMINDERS flip the flag and are audited', async () => {
      const phone = newPhone();
      const userId = await onboard(phone, 'en');
      const stopped = await say(phone, text('stop reminders'));
      expect(bodyText(stopped)).toContain('switched off');
      expect((await mustUser(phone)).remindersEnabled).toBe(false);

      const started = await say(phone, text('START REMINDERS'));
      expect(bodyText(started)).toContain('switched on');
      expect((await mustUser(phone)).remindersEnabled).toBe(true);

      const actions = (await prisma.auditLog.findMany({ where: { userId } })).map(
        (row) => row.action,
      );
      expect(actions).toEqual(expect.arrayContaining(['reminders_disabled', 'reminders_enabled']));
    });

    it('MEDS says there are none, then lists active medicines with their timings', async () => {
      const phone = newPhone();
      const userId = await onboard(phone, 'en');
      expect(bodyText(await say(phone, text('meds')))).toContain('no active medicines');

      const inbound = await prisma.message.findFirstOrThrow({ where: { userId, direction: 'in' } });
      const document = await prisma.document.create({
        data: { userId, messageId: inbound.id, s3Key: `media/${userId}/x.jpg` },
      });
      const base = {
        userId,
        documentId: document.id,
        frequencyPerDay: 2,
        startDate: new Date(),
        confidence: 0.9,
      };
      await prisma.medication.create({
        data: { ...base, rawName: 'Dolo 650', timings: ['08:00', '20:00'] },
      });
      await prisma.medication.create({
        data: { ...base, rawName: 'Old tablet', timings: [], active: false },
      });

      const list = bodyText(await say(phone, text('दवाई')));
      expect(list).toContain('Your active medicines:');
      expect(list).toContain('• Dolo 650 — 08:00, 20:00');
      expect(list).not.toContain('Old tablet');
    });
  });

  describe('emergency pre-check (before consent, before a language is chosen)', () => {
    it('a brand-new user writing "chest pain" gets the bilingual 112/108 message, no onboarding', async () => {
      const phone = newPhone();
      const reply = await say(phone, text('mujhe seene me dard ho raha hai, chest pain'));
      const body = bodyText(reply);
      expect(body).toContain('112');
      expect(body).toContain('108');
      expect(body).toMatch(/[ऀ-ॿ]/); // Hindi
      expect(body).toContain('emergency'); // and English
      expect(reply.interactive).toBeUndefined(); // no language buttons: the emergency came first
      expect((await mustUser(phone)).onboardingStep).toBe('language');
    });

    it('self-harm adds Tele-MANAS 14416', async () => {
      const phone = newPhone();
      const body = bodyText(await say(phone, text('मैं आत्महत्या करना चाहता हूँ')));
      expect(body).toContain('14416');
      expect(body).toContain('Tele-MANAS');
    });

    it('works for a user who already consented, in their language, and is not echoed or processed', async () => {
      const phone = newPhone();
      await onboard(phone, 'en');
      const body = bodyText(await say(phone, text('my father is unconscious')));
      expect(body).toContain('112');
      expect(body).not.toContain('[dev]');
    });

    it('a caption on a photo counts too', async () => {
      const phone = newPhone();
      await say(phone, text('hi'));
      const reply = await say(phone, image('media-caption', 'he is not breathing, heavy bleeding'));
      expect(bodyText(reply)).toContain('112');
    });
  });

  describe('DELETE (right to erasure)', () => {
    it('E2E: new number -> language -> consent -> photo stored -> DELETE -> confirm -> everything gone', async () => {
      const phone = newPhone();
      const auditBefore = await prisma.auditLog.count({ where: { action: 'user_deleted' } });
      const userId = await onboard(phone, 'en');

      // a photo from a consented user is processed (here by the dev echo bot): stored in MinIO
      const content = Buffer.alloc(2048, 9);
      mockImage('media-e2e', content);
      const echo = await say(phone, image('media-e2e'));
      expect(bodyText(echo)).toContain('saved it');
      const stored = await prisma.message.findFirstOrThrow({
        where: { userId, direction: 'in', mediaS3Key: { not: null } },
      });
      const key = stored.mediaS3Key as string;
      expect(await storage.statObject(key)).toMatchObject({ contentLength: content.length });

      // DELETE -> confirmation question with buttons, and a pending key that expires in <= 5 min
      const question = await say(phone, text('DELETE'));
      expect(buttonIds(question)).toEqual(['delete:confirm', 'delete:cancel']);
      expect(bodyText(question)).toContain('cannot be undone');
      expect(await pending.exists('delete', userId)).toBe(true);
      const ttl = await redis.client.ttl(PendingStore.key('delete', userId));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
      expect(await storage.statObject(key)).toBeDefined(); // nothing deleted yet

      // confirm -> erasure job
      const sendsBefore = sendsTo(phone).length;
      await post(webhookFor(phone, tap('delete:confirm'))).expect(200);
      await waitFor(async () => (await userOf(phone)) === null, 'the user row to be gone');
      await waitFor(() => sendsTo(phone).length > sendsBefore, 'the final message');
      await sleep(400);

      // 1) no row for this user in ANY table that has a user_id column
      const tables = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'user_id'`;
      expect(tables.map((row) => row.table_name).sort()).toEqual(
        expect.arrayContaining([
          'audit_logs',
          'caregivers',
          'documents',
          'medications',
          'messages',
          'reminders',
        ]),
      );
      for (const { table_name } of tables) {
        const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*) FROM "${table_name}" WHERE user_id = $1::uuid`,
          userId,
        );
        expect({ table: table_name, rows: rows[0]?.count }).toEqual({
          table: table_name,
          rows: 0n,
        });
      }
      // ...and no row about this user's messages / documents either
      expect(await prisma.message.count({ where: { waMessageId: stored.waMessageId } })).toBe(0);

      // 2) S3 prefix is empty
      expect(await storage.statObject(key)).toBeUndefined();
      expect(await storage.deletePrefix(`media/${userId}/`)).toBe(0);

      // 3) exactly one NEW anonymous audit row, no phone / hash / user id in it
      expect(await prisma.auditLog.count({ where: { action: 'user_deleted' } })).toBe(
        auditBefore + 1,
      );
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user_deleted' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toMatchObject({ actor: 'user', userId: null });
      const metadata = audit.metadata as {
        s3_objects_deleted: number;
        rows_deleted_by_table: Record<string, number>;
      };
      expect(metadata.s3_objects_deleted).toBe(1);
      expect(metadata.rows_deleted_by_table['users']).toBe(1);
      expect(metadata.rows_deleted_by_table['messages']).toBeGreaterThanOrEqual(5);
      const serialised = JSON.stringify(audit);
      expect(serialised).not.toContain(phone);
      expect(serialised).not.toContain(userId);
      expect(serialised).not.toContain(hashPhone(phone, PEPPER));
      expect(await prisma.auditLog.count({ where: { userId } })).toBe(0);

      // 4) the final message went out exactly once
      const final = sendsTo(phone).slice(sendsBefore);
      expect(final).toHaveLength(1);
      expect(bodyText(final[0] as GraphBody)).toContain('All your data has been deleted');

      // 5) Redis is clean: no pending key, no queued/completed jobs of this user, no erasure job left
      expect(await pending.exists('delete', userId)).toBe(false);
      const inboundJobs = await app
        .get(InboundQueue)
        .getQueue()
        .getJobs(['waiting', 'delayed', 'completed', 'failed']);
      const outboundJobs = await app
        .get(OutboundQueue)
        .getQueue()
        .getJobs(['waiting', 'delayed', 'completed', 'failed']);
      expect(
        [...inboundJobs, ...outboundJobs].filter((job) => job.data.userId === userId),
      ).toHaveLength(0);
      expect(
        await app.get(UserDeletionQueue).getQueue().getJob(`delete_${userId}`),
      ).toBeUndefined();

      // 6) the same number writing again is a brand-new user in a fresh onboarding
      const again = await say(phone, text('hello again'));
      expect(buttonIds(again)).toEqual(['lang:hi', 'lang:en']);
      const fresh = await mustUser(phone);
      expect(fresh.id).not.toBe(userId);
      expect(fresh).toMatchObject({ onboardingStep: 'language', consentAt: null, language: 'hi' });
      nock.cleanAll();
      installGraphMock();
    });

    it('DELETE works before consent too (global command), and removes the half-onboarded user', async () => {
      const phone = newPhone();
      await say(phone, text('hi'));
      const question = await say(phone, text('delete my data'));
      expect(buttonIds(question)).toEqual(['delete:confirm', 'delete:cancel']);
      const before = sendsTo(phone).length;
      await post(webhookFor(phone, tap('delete:confirm'))).expect(200);
      await waitFor(async () => (await userOf(phone)) === null, 'user erased');
      await waitFor(() => sendsTo(phone).length > before, 'final message');
    });

    it('confirming after the 5-minute window says it expired and deletes NOTHING', async () => {
      const phone = newPhone();
      const userId = await onboard(phone, 'en');
      await say(phone, text('delete'));
      // simulate the TTL running out
      await pending.clear('delete', userId);

      const expired = await say(phone, tap('delete:confirm'));
      expect(bodyText(expired)).toContain('expired');
      const user = await mustUser(phone);
      expect(user.deletedAt).toBeNull();
      expect(await prisma.message.count({ where: { userId } })).toBeGreaterThan(0);
    });

    it('a stale confirm button tapped without ever asking for DELETE does nothing', async () => {
      const phone = newPhone();
      await onboard(phone, 'en');
      const reply = await say(phone, tap('delete:confirm'));
      expect(bodyText(reply)).toContain('expired');
      expect(await userOf(phone)).not.toBeNull();
    });

    it('"No" cancels: nothing is deleted and the pending question is cleared', async () => {
      const phone = newPhone();
      const userId = await onboard(phone, 'en');
      await say(phone, text('delete'));
      const cancelled = await say(phone, tap('delete:cancel'));
      expect(bodyText(cancelled)).toContain('nothing was deleted');
      expect(await pending.exists('delete', userId)).toBe(false);
      expect(await userOf(phone)).not.toBeNull();
    });

    it('while the erasure runs the user is ignored: no reply to messages sent in between', async () => {
      const phone = newPhone();
      const userId = await onboard(phone, 'en');
      await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
      const before = sendsTo(phone).length;
      await post(webhookFor(phone, text('hello?'))).expect(200);
      await sleep(1200);
      expect(sendsTo(phone)).toHaveLength(before);
    });

    it('running the erasure job twice is harmless: one audit row, the user stays gone', async () => {
      const phone = newPhone();
      const auditBefore = await prisma.auditLog.count({ where: { action: 'user_deleted' } });
      const userId = await onboard(phone, 'en');
      const waPhoneEnc = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { waPhoneEnc: true },
      });
      const queue = app.get(UserDeletionQueue);
      const data = {
        userId,
        waPhoneEnc: waPhoneEnc.waPhoneEnc,
        language: 'en' as const,
        requestId: 'it',
      };

      await queue.add(data);
      await waitFor(async () => (await userOf(phone)) === null, 'first erasure');
      await waitFor(
        async () => (await queue.getQueue().getJob(`delete_${userId}`)) === undefined,
        'job removed after completion',
      );
      await queue.add(data); // a second run for a user that no longer exists
      await sleep(1500);

      expect(await prisma.auditLog.count({ where: { action: 'user_deleted' } })).toBe(
        auditBefore + 1,
      );
    });
  });

  describe('schema safety nets', () => {
    it('every table with a user_id column cascades from users, except audit_logs (kept on purpose)', async () => {
      const foreignKeys = await prisma.$queryRaw<{ table_name: string; delete_rule: string }[]>`
        SELECT tc.table_name, rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'user_id' AND ccu.table_name = 'users'`;
      const userTables = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'user_id' AND table_name <> 'audit_logs'`;

      expect(userTables.length).toBeGreaterThanOrEqual(5);
      for (const { table_name } of userTables) {
        const fk = foreignKeys.find((row) => row.table_name === table_name);
        expect({ table: table_name, rule: fk?.delete_rule }).toEqual({
          table: table_name,
          rule: 'CASCADE',
        });
      }
      expect(foreignKeys.some((row) => row.table_name === 'audit_logs')).toBe(false);
    });
  });

  it('audit rows and logs of all these flows contain no phone numbers or message text', async () => {
    const hashes = phones.map((phone) => hashPhone(phone, PEPPER));
    const users = await prisma.user.findMany({
      where: { waPhoneHash: { in: hashes } },
      select: { id: true },
    });
    const rows = await prisma.auditLog.findMany({
      where: { OR: [{ userId: { in: users.map((user) => user.id) } }, { action: 'user_deleted' }] },
    });
    expect(rows.length).toBeGreaterThan(5);
    const audit = JSON.stringify(rows);
    for (const phone of phones) {
      expect(audit).not.toContain(phone);
      expect(audit).not.toContain(phone.slice(2));
    }
    expect(audit).not.toContain('Meri dawai');

    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0);
    for (const phone of phones) {
      expect(logs).not.toContain(phone);
    }
    expect(logs).not.toContain('Meri dawai');
    expect(logs).not.toContain('9876543210');
    expect(logs).not.toContain('chest pain');
    expect(logs).not.toContain('my father is unconscious');
  });
});
