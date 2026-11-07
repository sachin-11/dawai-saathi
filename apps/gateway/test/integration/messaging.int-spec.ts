/**
 * M3 integration tests: webhook -> inbound queue -> worker (echo bot) -> outbound queue -> worker ->
 * Graph API. Postgres, Redis and MinIO are REAL (docker-compose.test.yml); the WhatsApp Graph API is
 * mocked with nock, which lets us assert the exact requests the bot would send to Meta.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import type { INestApplication } from '@nestjs/common';
import { Logger as PinoNestLogger } from 'nestjs-pino';
import nock from 'nock';
import request from 'supertest';
import type { App } from 'supertest/types';

import { CryptoService } from '../../src/common/crypto/crypto.service';
import { hashPhone } from '../../src/common/crypto/crypto.util';
import { LOG_STREAM } from '../../src/common/logger/log-stream';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { OutboundQueue } from '../../src/messaging/outbound.queue';
import { OutboundService } from '../../src/messaging/outbound.service';
import { WindowClosedError } from '../../src/messaging/window';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';
import { createApp, signedHeaders } from '../support/webhook-test-utils';

const GRAPH = 'https://graph.facebook.com';
const SEND_PATH = '/v21.0/100000000000001/messages';
const URL = '/webhook/whatsapp';
const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';
const TOKEN = INTEGRATION_ENV['WA_ACCESS_TOKEN'] ?? '';

const logLines: string[] = [];
const logStream = new Writable({
  write(chunk: Buffer, _encoding, callback): void {
    logLines.push(chunk.toString());
    callback();
  },
});

interface GraphBody {
  messaging_product: string;
  to?: string;
  type?: string;
  status?: string;
  message_id?: string;
  text?: { body: string };
  template?: { name: string; language: { code: string } };
}

/** What our fake WhatsApp Cloud API saw, and how it should answer the next send. */
const graph = {
  sends: [] as GraphBody[],
  reads: [] as GraphBody[],
  counter: 0,
  /** Per-test override: return a status/body instead of the default success. */
  respond: undefined as undefined | ((body: GraphBody) => [number, object] | undefined),
};

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
      const custom = graph.respond?.(payload);
      if (custom) return custom;
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

const textMessage = (body: string): Record<string, unknown> => ({ type: 'text', text: { body } });
const imageMessage = (mediaId: string): Record<string, unknown> => ({
  type: 'image',
  image: { id: mediaId, mime_type: 'image/jpeg' },
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

describe('messaging (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: StorageService;
  let outboundQueue: OutboundQueue;
  let outbound: OutboundService;
  const phones: string[] = [];
  const userIds = new Set<string>();

  const post = (raw: Buffer): request.Test =>
    request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());

  const sendsTo = (phone: string): GraphBody[] => graph.sends.filter((body) => body.to === phone);

  const userFor = async (phone: string): Promise<{ id: string }> => {
    const user = await waitFor(
      () =>
        prisma.user.findUnique({
          where: { waPhoneHash: hashPhone(phone, PEPPER) },
          select: { id: true },
        }),
      'user row',
    );
    userIds.add(user.id);
    return user;
  };

  /** The echo bot only answers users who finished onboarding (M4), so create such a user first. */
  const onboardedUser = async (phone: string): Promise<{ id: string }> => {
    const user = await prisma.user.create({
      data: {
        waPhoneHash: hashPhone(phone, PEPPER),
        waPhoneEnc: app.get(CryptoService).encrypt(phone),
        onboardingStep: 'done',
        consentAt: new Date(),
        consentVersion: 'v1',
      },
    });
    userIds.add(user.id);
    return user;
  };

  const outboundRows = (
    userId: string,
  ): Promise<{ waMessageId: string; type: string; bodyRedacted: string | null }[]> =>
    prisma.message.findMany({
      where: { userId, direction: 'out' },
      select: { waMessageId: true, type: true, bodyRedacted: true },
    });

  beforeAll(async () => {
    Object.assign(process.env, {
      ...INTEGRATION_ENV,
      WORKERS_ENABLED: 'true',
      DEV_ECHO_BOT: 'true',
    });
    prepareTestDatabase(INTEGRATION_ENV['DATABASE_URL'] ?? '');
    // Real local services (Postgres is not HTTP; MinIO is) stay reachable, everything else is blocked.
    nock.disableNetConnect();
    nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);
    installGraphMock();

    app = (await createApp((builder) =>
      builder.overrideProvider(LOG_STREAM).useValue(logStream),
    )) as INestApplication<App>;
    app.useLogger(app.get(PinoNestLogger));
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    outboundQueue = app.get(OutboundQueue);
    outbound = app.get(OutboundService);
  });

  afterEach(() => {
    graph.respond = undefined;
  });

  afterAll(async () => {
    for (const id of userIds) {
      await storage.deletePrefix(`media/${id}/`);
    }
    await prisma.user.deleteMany({
      where: { waPhoneHash: { in: phones.map((phone) => hashPhone(phone, PEPPER)) } },
    });
    await app.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('dev echo bot: text', () => {
    it('inbound text -> blue ticks -> ONE echo reply with the exact payload -> outbound row', async () => {
      const phone = randomPhone();
      phones.push(phone);
      await onboardedUser(phone);
      const raw = webhookFor(phone, textMessage('Dolo 650 kab leni hai? Mera number 9876543210'));
      const waId = (
        JSON.parse(raw.toString()) as {
          entry: { changes: { value: { messages: { id: string }[] } }[] }[];
        }
      ).entry[0]?.changes[0]?.value.messages[0]?.id as string;

      await post(raw).expect(200);
      const user = await userFor(phone);
      const rows = await waitFor(async () => {
        const found = await outboundRows(user.id);
        return found.length > 0 ? found : null;
      }, 'outbound row');

      // 1) read receipt for the inbound message
      expect(graph.reads.filter((body) => body.message_id === waId)).toHaveLength(1);

      // 2) exactly one reply, with the exact Graph API payload (Hindi echo, text already redacted)
      const sends = sendsTo(phone);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: {
          body: '[dev] आपने लिखा: Dolo 650 kab leni hai? Mera number [REDACTED_PHONE]',
          preview_url: false,
        },
      });

      // 3) the outbound row carries the wamid Meta returned, and no phone number
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'text' });
      expect(rows[0]?.waMessageId).toMatch(/^wamid\.OUT\d+$/);
      expect(rows[0]?.bodyRedacted).toContain('[REDACTED_PHONE]');
      expect(rows[0]?.bodyRedacted).not.toContain(phone);

      // 4) Meta redelivers the same webhook: still only one reply (idempotent at every layer)
      await post(raw).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(sendsTo(phone)).toHaveLength(1);
      expect(await outboundRows(user.id)).toHaveLength(1);
    });

    it('answers a button tap with the button id, and an unsupported type politely', async () => {
      const phone = randomPhone();
      phones.push(phone);
      await onboardedUser(phone);
      await post(
        webhookFor(phone, {
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: 'consent_yes', title: 'I agree' },
          },
        }),
      ).expect(200);
      await post(webhookFor(phone, { type: 'sticker', sticker: { id: 'stk-1' } })).expect(200);

      await waitFor(() => sendsTo(phone).length >= 2, 'two replies');
      const bodies = sendsTo(phone).map((body) => body.text?.body ?? '');
      expect(bodies.some((text) => text === '[dev] आपने लिखा: consent_yes')).toBe(true);
      expect(bodies.some((text) => text.includes('माफ़ कीजिए'))).toBe(true);
    });
  });

  describe('inbound media -> S3', () => {
    const content = Buffer.alloc(2048, 7);
    const sha256 = createHash('sha256').update(content).digest('hex');

    it('downloads the image, stores it encrypted under a PII-free key and replies with its size', async () => {
      const phone = randomPhone();
      phones.push(phone);
      await onboardedUser(phone);
      nock(GRAPH).get('/v21.0/media-int-1').reply(200, {
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=int1',
        mime_type: 'image/jpeg',
        file_size: content.length,
        sha256,
        id: 'media-int-1',
      });
      nock('https://lookaside.fbsbx.com')
        .get('/whatsapp_business/attachments/')
        .query({ mid: 'int1' })
        .matchHeader('authorization', `Bearer ${TOKEN}`)
        .reply(200, content, {
          'content-type': 'image/jpeg',
          'content-length': String(content.length),
        });

      await post(webhookFor(phone, imageMessage('media-int-1'))).expect(200);
      const user = await userFor(phone);

      const message = await waitFor(async () => {
        const found = await prisma.message.findFirst({
          where: { userId: user.id, direction: 'in', mediaS3Key: { not: null } },
        });
        return found;
      }, 'media_s3_key');

      const key = message.mediaS3Key as string;
      const now = new Date();
      expect(key).toBe(
        `media/${user.id}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${message.id}.jpg`,
      );
      expect(key).not.toContain(phone);

      const stat = await storage.statObject(key);
      expect(stat).toMatchObject({
        contentLength: content.length,
        contentType: 'image/jpeg',
        encryption: 'AES256',
      });

      // The stored bytes are the downloaded bytes.
      const url = await storage.getPresignedUrl(key, 60);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(content);

      await waitFor(() => sendsTo(phone).length === 1, 'echo reply');
      expect(sendsTo(phone)[0]?.text?.body).toBe('[dev] आपका image मिल गया (2 KB) और सेव हो गया।');
    });

    it('does not download a file over MAX_MEDIA_MB and says so', async () => {
      const phone = randomPhone();
      phones.push(phone);
      await onboardedUser(phone);
      nock(GRAPH)
        .get('/v21.0/media-int-big')
        .reply(200, {
          url: 'https://lookaside.fbsbx.com/big',
          mime_type: 'image/jpeg',
          file_size: 50 * 1024 * 1024,
          id: 'media-int-big',
        });

      await post(webhookFor(phone, imageMessage('media-int-big'))).expect(200);
      await waitFor(() => sendsTo(phone).length === 1, 'too-large reply');
      expect(sendsTo(phone)[0]?.text?.body).toContain('10 MB');

      const user = await userFor(phone);
      const row = await prisma.message.findFirstOrThrow({
        where: { userId: user.id, direction: 'in' },
      });
      expect(row.mediaS3Key).toBeNull();
    });

    it('rejects a disallowed file type without downloading', async () => {
      const phone = randomPhone();
      phones.push(phone);
      await onboardedUser(phone);
      nock(GRAPH).get('/v21.0/media-int-vid').reply(200, {
        url: 'https://lookaside.fbsbx.com/v',
        mime_type: 'video/mp4',
        file_size: 100,
        id: 'media-int-vid',
      });

      await post(webhookFor(phone, imageMessage('media-int-vid'))).expect(200);
      await waitFor(() => sendsTo(phone).length === 1, 'unsupported-type reply');
      expect(sendsTo(phone)[0]?.text?.body).toContain('माफ़ कीजिए');
    });
  });

  describe('delivery statuses', () => {
    const statusHook = (
      waMessageId: string,
      status: string,
      ts: number,
      errors?: { code: number }[],
    ): Buffer =>
      Buffer.from(
        JSON.stringify({
          object: 'whatsapp_business_account',
          entry: [
            {
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: '100000000000001' },
                    statuses: [
                      {
                        id: waMessageId,
                        status,
                        timestamp: String(ts),
                        recipient_id: '919999999999',
                        ...(errors ? { errors } : {}),
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );

    const createOutboundRow = async (): Promise<{ waMessageId: string }> => {
      const phone = randomPhone();
      phones.push(phone);
      const user = await prisma.user.create({
        data: { waPhoneHash: hashPhone(phone, PEPPER), waPhoneEnc: 'enc' },
      });
      userIds.add(user.id);
      const waMessageId = `wamid.ST${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await prisma.message.create({
        data: { userId: user.id, direction: 'out', waMessageId, type: 'text', bodyRedacted: 'x' },
      });
      return { waMessageId };
    };

    const row = (
      waMessageId: string,
    ): Promise<{
      deliveryStatus: string | null;
      errorCode: string | null;
      statusUpdatedAt: Date | null;
    }> =>
      prisma.message.findUniqueOrThrow({
        where: { waMessageId },
        select: { deliveryStatus: true, errorCode: true, statusUpdatedAt: true },
      });

    it("moves sent -> delivered -> read and stores Meta's timestamp", async () => {
      const { waMessageId } = await createOutboundRow();
      await post(statusHook(waMessageId, 'sent', 1794000100)).expect(200);
      expect(await row(waMessageId)).toMatchObject({ deliveryStatus: 'sent' });
      await post(statusHook(waMessageId, 'delivered', 1794000110)).expect(200);
      expect(await row(waMessageId)).toMatchObject({ deliveryStatus: 'delivered' });
      await post(statusHook(waMessageId, 'read', 1794000120)).expect(200);
      const final = await row(waMessageId);
      expect(final.deliveryStatus).toBe('read');
      expect(final.statusUpdatedAt?.toISOString()).toBe(new Date(1794000120 * 1000).toISOString());
    });

    it('ignores out-of-order receipts: a late "delivered" or "sent" never undoes "read"', async () => {
      const { waMessageId } = await createOutboundRow();
      await post(statusHook(waMessageId, 'read', 1794000200)).expect(200);
      await post(statusHook(waMessageId, 'delivered', 1794000190)).expect(200);
      await post(statusHook(waMessageId, 'sent', 1794000180)).expect(200);
      expect(await row(waMessageId)).toMatchObject({ deliveryStatus: 'read' });
    });

    it('stores a failure and its error code, but "failed" cannot overwrite "delivered"', async () => {
      const failing = await createOutboundRow();
      await post(statusHook(failing.waMessageId, 'failed', 1794000300, [{ code: 131047 }])).expect(
        200,
      );
      expect(await row(failing.waMessageId)).toMatchObject({
        deliveryStatus: 'failed',
        errorCode: '131047',
      });

      const delivered = await createOutboundRow();
      await post(statusHook(delivered.waMessageId, 'delivered', 1794000310)).expect(200);
      await post(
        statusHook(delivered.waMessageId, 'failed', 1794000320, [{ code: 131026 }]),
      ).expect(200);
      expect(await row(delivered.waMessageId)).toMatchObject({
        deliveryStatus: 'delivered',
        errorCode: null,
      });
    });

    it('a receipt that beats our own insert is applied shortly after (race)', async () => {
      const phone = randomPhone();
      phones.push(phone);
      const user = await prisma.user.create({
        data: { waPhoneHash: hashPhone(phone, PEPPER), waPhoneEnc: 'enc' },
      });
      userIds.add(user.id);
      const waMessageId = `wamid.RACE${randomUUID().replaceAll('-', '').slice(0, 10)}`;

      await post(statusHook(waMessageId, 'delivered', 1794000400)).expect(200); // row does not exist yet
      await prisma.message.create({
        data: { userId: user.id, direction: 'out', waMessageId, type: 'text', bodyRedacted: 'x' },
      });

      const applied = await waitFor(
        async () => {
          const current = await row(waMessageId);
          return current.deliveryStatus === 'delivered' ? current : null;
        },
        'delayed status update',
        5_000,
      );
      expect(applied.deliveryStatus).toBe('delivered');
    });

    it('a receipt for a message we never sent is accepted and creates nothing', async () => {
      const before = await prisma.message.count();
      await post(statusHook('wamid.NEVERSENT', 'read', 1794000500)).expect(200);
      expect(await prisma.message.count()).toBe(before);
    });
  });

  describe('outbound queue', () => {
    const createUser = async (
      lastInboundAt: Date | null,
    ): Promise<{ id: string; phone: string }> => {
      const phone = randomPhone();
      phones.push(phone);
      const crypto = app.get(CryptoService);
      const user = await prisma.user.create({
        data: {
          waPhoneHash: hashPhone(phone, PEPPER),
          waPhoneEnc: crypto.encrypt(phone),
          lastInboundAt,
        },
      });
      userIds.add(user.id);
      return { id: user.id, phone };
    };

    it('the same (sourceMessageId, replyIndex) enqueued twice sends exactly once', async () => {
      const { id, phone } = await createUser(new Date());
      const source = randomUUID();
      const request = {
        content: { kind: 'text' as const, body: 'once only' },
        sourceMessageId: source,
        replyIndex: 0,
      };
      await outbound.enqueue(id, request);
      await outbound.enqueue(id, request);
      await waitFor(() => sendsTo(phone).length >= 1, 'first send');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(sendsTo(phone)).toHaveLength(1);
      expect(await outboundRows(id)).toHaveLength(1);
    });

    it('stores the job payload encrypted: no readable text in Redis', async () => {
      const { id } = await createUser(new Date());
      const source = randomUUID();
      graph.respond = (): [number, object] => [400, { error: { code: 100, message: 'x' } }]; // job fails and stays inspectable
      await outbound.enqueue(id, {
        content: { kind: 'text', body: 'Aapki Metformin 500 mg subah leni hai' },
        sourceMessageId: source,
        replyIndex: 0,
      });
      const job = await waitFor(
        async () => outboundQueue.getQueue().getJob(`${source}_0`),
        'outbound job',
      );
      const serialised = JSON.stringify(job.data);
      expect(serialised).not.toContain('Metformin');
      expect(serialised).toContain('"payload":"v1:');
    });

    it('rejects free-form text outside the 24 h window, and a template fallback is sent instead', async () => {
      const { id, phone } = await createUser(new Date(Date.now() - 30 * 60 * 60 * 1000));
      await expect(
        outbound.enqueue(id, {
          content: { kind: 'text', body: 'hi' },
          sourceMessageId: randomUUID(),
          replyIndex: 0,
        }),
      ).rejects.toBeInstanceOf(WindowClosedError);
      expect(sendsTo(phone)).toHaveLength(0);

      await outbound.enqueue(id, {
        content: { kind: 'text', body: 'hi' },
        templateFallback: { kind: 'template', template: 'generic_reengage', language: 'hi' },
        sourceMessageId: randomUUID(),
        replyIndex: 0,
      });
      await waitFor(() => sendsTo(phone).length === 1, 'template send');
      expect(sendsTo(phone)[0]).toMatchObject({
        type: 'template',
        template: { name: 'generic_reengage', language: { code: 'hi' } },
      });
      const rows = await waitFor(async () => {
        const found = await outboundRows(id);
        return found.length ? found : null;
      }, 'template row');
      expect(rows[0]).toMatchObject({
        type: 'template',
        bodyRedacted: '[template:generic_reengage]',
      });
    });

    it('retries a transient Meta failure and still ends with ONE message', async () => {
      const { id, phone } = await createUser(new Date());
      let calls = 0;
      graph.respond = (): [number, object] | undefined => {
        calls += 1;
        return calls === 1
          ? [503, { error: { code: 2, message: 'temporarily unavailable' } }]
          : undefined;
      };
      await outbound.enqueue(id, {
        content: { kind: 'text', body: 'retry me' },
        sourceMessageId: randomUUID(),
        replyIndex: 0,
      });
      await waitFor(async () => (await outboundRows(id)).length === 1, 'outbound row after retry');
      expect(sendsTo(phone).length).toBe(2); // 503, then success
      expect(await outboundRows(id)).toHaveLength(1);
    });

    it('fails immediately, without retries, on a non-retryable error (131047) and stores nothing', async () => {
      const { id, phone } = await createUser(new Date());
      const source = randomUUID();
      graph.respond = (): [number, object] => [
        400,
        { error: { code: 131047, message: 'Re-engagement message' } },
      ];
      await outbound.enqueue(id, {
        content: { kind: 'text', body: 'nope' },
        sourceMessageId: source,
        replyIndex: 0,
      });
      const job = await waitFor(async () => {
        const found = await outboundQueue.getQueue().getJob(`${source}_0`);
        return found && (await found.getState()) === 'failed' ? found : null;
      }, 'failed job');
      expect(job.attemptsMade).toBe(1); // no retries burned
      expect(job.failedReason).toBe('whatsapp window_closed error (code 131047)');
      expect(sendsTo(phone)).toHaveLength(1);
      expect(await outboundRows(id)).toHaveLength(0);
    });
  });

  describe('storage', () => {
    it('presigned URLs work and expire; deleteObject and deletePrefix remove objects', async () => {
      const prefix = `media/it-${randomUUID()}/`;
      const keys = ['a.txt', 'b/c.txt', 'b/d.txt'].map((name) => `${prefix}${name}`);
      for (const key of keys) {
        await storage.putStream({
          key,
          body: Readable.from([Buffer.from(key)]),
          contentType: 'text/plain',
        });
      }
      expect(await storage.statObject(keys[0] as string)).toMatchObject({ encryption: 'AES256' });

      const url = await storage.getPresignedUrl(keys[0] as string, 60);
      expect(await (await fetch(url)).text()).toBe(keys[0]);

      await storage.deleteObject(keys[0] as string);
      expect(await storage.statObject(keys[0] as string)).toBeUndefined();

      expect(await storage.deletePrefix(prefix)).toBe(2);
      expect(await storage.statObject(keys[1] as string)).toBeUndefined();
      expect(await storage.deletePrefix(prefix)).toBe(0);
    });

    it('refuses a dangerous prefix that could wipe the bucket', async () => {
      await expect(storage.deletePrefix('')).rejects.toThrow(/ends with/);
      await expect(storage.deletePrefix('media')).rejects.toThrow(/ends with/);
      await expect(storage.deletePrefix('/')).rejects.toThrow(/ends with/);
    });
  });

  it('logs never contain the access token or a phone number', () => {
    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).toContain('whatsapp api call');
    expect(logs).not.toContain(TOKEN);
    for (const phone of phones) {
      expect(logs).not.toContain(phone);
    }
    expect(logs).not.toContain('9876543210');
    expect(logs).not.toContain('Metformin');
    expect(logs).not.toContain('Dolo 650');
  });
});

describe('AI branch (integration)', () => {
  const AI = 'http://localhost:8000';
  const aiResponse = (text: string): object => ({
    request_id: 'x',
    intent: 'help',
    emergency: false,
    extraction: null,
    warnings: [],
    reply: { language: 'hi', text, buttons: [] },
    meta: {
      model: 'fake-model',
      prompt_version: 'v1',
      latency_ms: 5,
      cost_usd: 0,
      trace_id: null,
      provider: 'fake',
      fallback_used: false,
    },
  });

  async function run(
    aiBehaviour: (body: { input: { text?: string } }) => [number, object],
    expectedSends: number,
  ): Promise<{ replies: string[]; aiBodies: Array<{ input: { text?: string } }> }> {
    Object.assign(process.env, {
      ...INTEGRATION_ENV,
      WORKERS_ENABLED: 'true',
      DEV_ECHO_BOT: 'false',
    });
    nock.disableNetConnect();
    nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);
    installGraphMock();
    graph.sends.length = 0;
    graph.reads.length = 0;
    const aiBodies: Array<{ input: { text?: string } }> = [];
    nock(AI)
      .persist()
      .post('/v1/process')
      .matchHeader('x-service-token', INTEGRATION_ENV['SERVICE_TOKEN'] ?? '')
      .reply((_uri, body) => {
        aiBodies.push(body as { input: { text?: string } });
        return aiBehaviour(body as { input: { text?: string } });
      });

    const app = (await createApp()) as INestApplication<App>;
    const prisma = app.get(PrismaService);
    const phone = randomPhone();
    const sendsTo = (to: string): GraphBody[] => graph.sends.filter((body) => body.to === to);
    try {
      await prisma.user.create({
        data: {
          waPhoneHash: hashPhone(phone, PEPPER),
          waPhoneEnc: app.get(CryptoService).encrypt(phone),
          onboardingStep: 'done',
          consentAt: new Date(),
          consentVersion: 'v1',
        },
      });
      const raw = webhookFor(phone, textMessage('kya kar sakte ho'));
      await request(app.getHttpServer())
        .post(URL)
        .set(signedHeaders(raw))
        .send(raw.toString())
        .expect(200);
      await waitFor(() => sendsTo(phone).length >= expectedSends, 'AI-branch reply');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        replies: sendsTo(phone).map((body) => body.text?.body ?? ''),
        aiBodies,
      };
    } finally {
      await prisma.user.deleteMany({ where: { waPhoneHash: hashPhone(phone, PEPPER) } });
      await app.close();
      nock.cleanAll();
      nock.enableNetConnect();
      process.env['DEV_ECHO_BOT'] = 'false';
      process.env['WORKERS_ENABLED'] = 'false';
    }
  }

  it('with DEV_ECHO_BOT off a consented user gets the AI service reply, exactly once', async () => {
    const { replies, aiBodies } = await run(() => [200, aiResponse('मैं दवाई साथी हूँ')], 1);
    expect(replies).toEqual(['मैं दवाई साथी हूँ']);
    expect(aiBodies).toHaveLength(1);
    expect(aiBodies[0]?.input.text).toBe('kya kar sakte ho');
    expect(graph.reads).toHaveLength(0); // text messages are not marked as read
  });

  it('when the AI service is down the user gets ONE error message, however often the job retries', async () => {
    const { replies } = await run(
      () => [503, { error: { status: 503, code: 'LLM_UNAVAILABLE' } }],
      1,
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toBeTruthy();
    expect(replies[0]).not.toContain('LLM_UNAVAILABLE');
  });
});
