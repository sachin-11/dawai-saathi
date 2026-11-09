/**
 * M13 integration tests: voice notes. A signed webhook with an `audio` message -> consent check ->
 * download -> MinIO -> (mocked) AI service -> reply, spoken command, one-time consent notice, VOICE ON and
 * the spoken reply (synthesise -> upload -> audio message after the text).
 * Real Postgres, Redis and MinIO (docker-compose.test.yml); the Graph API and the AI service are mocked
 * with nock. Workers run for real.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import nock from 'nock';
import request from 'supertest';
import type { App } from 'supertest/types';

import type { ProcessResponse } from '../../src/ai-client/types';
import { CryptoService } from '../../src/common/crypto/crypto.service';
import { hashPhone } from '../../src/common/crypto/crypto.util';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';
import { createApp, signedHeaders } from '../support/webhook-test-utils';

const GRAPH = 'https://graph.facebook.com';
const SEND_PATH = '/v21.0/100000000000001/messages';
const MEDIA_PATH = '/v21.0/100000000000001/media';
const AI = INTEGRATION_ENV['AI_SERVICE_URL'] ?? 'http://localhost:8000';
const URL = '/webhook/whatsapp';
const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';
const OGG = Buffer.from('OggS-fake-voice-note-bytes');

interface GraphBody {
  to?: string;
  type?: string;
  status?: string;
  text?: { body: string };
  audio?: { id: string };
  interactive?: {
    body: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] };
  };
}
const graph = { sends: [] as GraphBody[], uploads: 0 };
interface AiRequest {
  request_id: string;
  input: { type: string; media_url?: string; mime?: string };
  options?: { want_spoken?: boolean };
}
const aiRequests: AiRequest[] = [];
let nextAiResponse: (requestId: string) => ProcessResponse;

const reply = (requestId: string, overrides: Partial<ProcessResponse> = {}): ProcessResponse => ({
  request_id: requestId,
  intent: 'interaction_query',
  emergency: false,
  emergency_category: null,
  extraction: null,
  warnings: [],
  reply: { language: 'en', text: 'VOICE-ANSWER', buttons: [] },
  meta: {
    model: 'fake-model',
    prompt_version: 'reply_templates_v9',
    latency_ms: 5,
    cost_usd: 0,
    trace_id: null,
    provider: 'fake',
    fallback_used: false,
  },
  ...overrides,
});

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
const tap = (id: string): Record<string, unknown> => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title: 'x' } },
});
const voice = (mediaId: string): Record<string, unknown> => ({
  type: 'audio',
  audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus', voice: true },
});

async function waitFor<T>(
  produce: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  timeoutMs = 15_000,
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

describe('voice notes (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: StorageService;
  const userIds: string[] = [];

  const post = (raw: Buffer): request.Test =>
    request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());
  const sendsTo = (phone: string): GraphBody[] => graph.sends.filter((body) => body.to === phone);
  const textsTo = (phone: string): string[] =>
    sendsTo(phone).flatMap(
      (b) => [b.text?.body, b.interactive?.body.text].filter(Boolean) as string[],
    );

  const user = async (consentVersion: string): Promise<{ phone: string; userId: string }> => {
    const phone = randomPhone();
    const created = await prisma.user.create({
      data: {
        waPhoneHash: hashPhone(phone, PEPPER),
        waPhoneEnc: app.get(CryptoService).encrypt(phone),
        language: 'en',
        onboardingStep: 'done',
        consentAt: new Date(),
        consentVersion,
      },
    });
    userIds.push(created.id);
    return { phone, userId: created.id };
  };

  const say = async (
    phone: string,
    message: Record<string, unknown>,
    replies = 1,
  ): Promise<void> => {
    const before = sendsTo(phone).length;
    await post(webhookFor(phone, message)).expect(200);
    await waitFor(() => sendsTo(phone).length >= before + replies, 'replies');
    await sleep(300);
  };

  const mockVoice = (mediaId: string): void => {
    nock(GRAPH)
      .get(`/v21.0/${mediaId}`)
      .reply(200, {
        url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId}`,
        mime_type: 'audio/ogg; codecs=opus',
        file_size: OGG.length,
        sha256: createHash('sha256').update(OGG).digest('hex'),
        id: mediaId,
      });
    nock('https://lookaside.fbsbx.com')
      .get('/whatsapp_business/attachments/')
      .query({ mid: mediaId })
      .reply(200, OGG, { 'content-type': 'audio/ogg', 'content-length': String(OGG.length) });
  };

  const sendVoice = async (phone: string, replies = 1): Promise<string> => {
    const mediaId = `voice-${randomUUID().slice(0, 8)}`;
    mockVoice(mediaId);
    await say(phone, voice(mediaId), replies);
    return mediaId;
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ...INTEGRATION_ENV,
      WORKERS_ENABLED: 'true',
      DEV_ECHO_BOT: 'false',
      TTS_ENABLED: 'true',
    });
    prepareTestDatabase(INTEGRATION_ENV['DATABASE_URL'] ?? '');
    nock.disableNetConnect();
    nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);
    nock(GRAPH)
      .persist()
      .post(SEND_PATH)
      .reply((_uri, body) => {
        const payload = body as GraphBody;
        if (payload.status === 'read') return [200, { success: true }];
        graph.sends.push(payload);
        return [200, { messages: [{ id: `wamid.OUT${graph.sends.length}` }] }];
      });
    nock(GRAPH)
      .persist()
      .post(MEDIA_PATH)
      .reply(() => {
        graph.uploads += 1;
        return [200, { id: `MEDIA-UP-${graph.uploads}` }];
      });
    nock(AI)
      .persist()
      .post('/v1/process')
      .matchHeader('x-service-token', INTEGRATION_ENV['SERVICE_TOKEN'] ?? '')
      .reply((_uri, body) => {
        const requestBody = body as AiRequest;
        aiRequests.push(requestBody);
        return [200, nextAiResponse(requestBody.request_id)];
      });
    nock(AI)
      .persist()
      .post('/v1/synthesize')
      .matchHeader('x-service-token', INTEGRATION_ENV['SERVICE_TOKEN'] ?? '')
      .reply(() => [
        200,
        {
          request_id: 'x',
          audio_base64: Buffer.from('OggS-spoken-reply').toString('base64'),
          mime: 'audio/ogg',
          duration_s: 3,
          provider: 'fake',
          model: 'fake-tts',
          cost_usd: 0,
        },
      ]);
    app = (await createApp()) as INestApplication<App>;
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
  });

  beforeEach(() => {
    nextAiResponse = (id) => reply(id);
  });

  afterAll(async () => {
    for (const id of userIds) await storage.deletePrefix(`media/${id}/`);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
    nock.cleanAll();
    nock.enableNetConnect();
    process.env['WORKERS_ENABLED'] = 'false';
    process.env['TTS_ENABLED'] = 'false';
  });

  it('a voice note from a consent-v2 user is stored and sent to the AI service as audio; the text reply comes back', async () => {
    const { phone, userId } = await user('v2');
    const before = aiRequests.length;
    await sendVoice(phone);
    const sent = aiRequests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input.type).toBe('audio');
    expect(sent[0]?.input.mime).toBe('audio/ogg');
    expect(sent[0]?.input.media_url).toContain('dawai-media-test');
    expect(textsTo(phone)).toEqual(['VOICE-ANSWER']); // no generic "received" ack for a short voice note
    const message = await prisma.message.findFirstOrThrow({
      where: { userId, type: 'audio' },
      select: { mediaS3Key: true, bodyRedacted: true },
    });
    expect(message.mediaS3Key).toMatch(/\.ogg$/);
    expect(message.bodyRedacted).toBeNull();
  });

  it('a user on the old consent text gets the one-time notice; nothing is downloaded or sent to the AI service', async () => {
    const { phone, userId } = await user('v1');
    const before = aiRequests.length;
    await say(phone, voice('never-downloaded'), 1);
    expect(sendsTo(phone)[0]?.interactive?.action.buttons.map((b) => b.reply.id)).toEqual([
      'voice:ok',
      'voice:no',
    ]);
    expect(aiRequests.length).toBe(before);
    expect((await prisma.message.findFirstOrThrow({ where: { userId } })).mediaS3Key).toBeNull();
  });

  it('agreeing records consent v2 and audits it; the next voice note is processed', async () => {
    const { phone, userId } = await user('v1');
    await say(phone, voice('first'), 1);
    await say(phone, tap('voice:ok'), 1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).consentVersion).toBe(
      'v2',
    );
    const audit = await prisma.auditLog.findMany({ where: { userId, action: 'consent_updated' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toEqual({ version: 'v2', reason: 'voice' });
    const before = aiRequests.length;
    await sendVoice(phone);
    expect(aiRequests.length).toBe(before + 1);
  });

  it('"I will type" changes nothing and the voice note is still never sent', async () => {
    const { phone, userId } = await user('v1');
    await say(phone, tap('voice:no'), 1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).consentVersion).toBe(
      'v1',
    );
  });

  it('a spoken command is executed like the typed one: "meds dikhao" answers MEDS, no AI text', async () => {
    const { phone } = await user('v2');
    nextAiResponse = (id) =>
      reply(id, {
        intent: 'other',
        detected_command: 'meds',
        reply: { language: 'en', text: '👍', buttons: [] },
      });
    await sendVoice(phone);
    expect(textsTo(phone).join(' ')).not.toContain('👍');
    expect(textsTo(phone)).toHaveLength(1); // the MEDS answer ("no medicines yet")
  });

  it('DELETE by voice only asks for the confirmation button and deletes nothing', async () => {
    const { phone, userId } = await user('v2');
    nextAiResponse = (id) =>
      reply(id, {
        intent: 'other',
        detected_command: 'delete',
        reply: { language: 'en', text: '👍', buttons: [] },
      });
    await sendVoice(phone);
    const buttons = sendsTo(phone)[0]?.interactive?.action.buttons.map((b) => b.reply.id);
    expect(buttons).toEqual(['delete:confirm', 'delete:cancel']);
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { userId, action: 'user_deleted' } })).toBe(0);
  });

  it('a spoken emergency reply is plain text, and nothing is spoken even with VOICE ON', async () => {
    const { phone, userId } = await user('v2');
    await prisma.user.update({ where: { id: userId }, data: { voiceReplies: true } });
    nextAiResponse = (id) =>
      reply(id, {
        intent: 'emergency',
        emergency: true,
        emergency_category: 'cardiac',
        spoken_text: 'must never be synthesised',
        reply: { language: 'en', text: '🚨 Call 112 now', buttons: [] },
      });
    const uploads = graph.uploads;
    await sendVoice(phone);
    expect(textsTo(phone)).toEqual(['🚨 Call 112 now']);
    expect(graph.uploads).toBe(uploads);
    const audit = await prisma.auditLog.findMany({
      where: { userId, action: 'emergency_detected' },
    });
    expect(audit[0]?.metadata).toEqual({ category: 'cardiac' });
  });

  it('VOICE ON is saved and audited; a voice question then gets the text first and a voice message after it', async () => {
    const { phone, userId } = await user('v2');
    await say(phone, text('VOICE ON'), 1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).voiceReplies).toBe(
      true,
    );
    expect(
      await prisma.auditLog.count({ where: { userId, action: 'voice_replies_enabled' } }),
    ).toBe(1);

    nextAiResponse = (id) => reply(id, { spoken_text: 'chhota jawab' });
    const before = aiRequests.length;
    await sendVoice(phone, 2);
    expect(aiRequests[before]?.options?.want_spoken).toBe(true);
    const sent = sendsTo(phone);
    const textIndex = sent.findIndex((b) => b.text?.body === 'VOICE-ANSWER');
    const audioIndex = sent.findIndex((b) => b.type === 'audio');
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(audioIndex).toBeGreaterThan(textIndex);
    expect(sent[audioIndex]?.audio?.id).toMatch(/^MEDIA-UP-/);
  });

  it('VOICE OFF stops it; the AI service is no longer asked for spoken text', async () => {
    const { phone, userId } = await user('v2');
    await prisma.user.update({ where: { id: userId }, data: { voiceReplies: true } });
    await say(phone, text('VOICE OFF'), 1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).voiceReplies).toBe(
      false,
    );
    const before = aiRequests.length;
    await sendVoice(phone);
    expect(aiRequests[before]?.options?.want_spoken).toBe(false);
  });

  it('the stored voice note lives under the user media prefix, so DELETE erases it with the rest', async () => {
    const { phone, userId } = await user('v2');
    await sendVoice(phone);
    const message = await prisma.message.findFirstOrThrow({
      where: { userId, type: 'audio' },
      select: { mediaS3Key: true },
    });
    expect(message.mediaS3Key?.startsWith(`media/${userId}/`)).toBe(true);
    expect(await storage.statObject(message.mediaS3Key ?? '')).toMatchObject({
      contentLength: OGG.length,
      encryption: 'AES256',
    });
  });
});
