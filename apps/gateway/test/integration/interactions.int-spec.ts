/**
 * M11 integration tests: two prescriptions on different days with the same salt (paracetamol) ->
 * the second one gets a duplicate-ingredient warning that is stored once; the details button; MEDS
 * marker; CHECK; "Something is wrong" resolves the warning; DELETE erases it.
 * Real Postgres, Redis and MinIO (docker-compose.test.yml); WhatsApp Graph API and the AI service
 * are mocked with nock (the AI mock builds its findings from the medicine ids the gateway sent as
 * context, exactly like the real service does). Workers run for real.
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
const AI = INTEGRATION_ENV['AI_SERVICE_URL'] ?? 'http://localhost:8000';
const URL = '/webhook/whatsapp';
const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';
const TOKEN = INTEGRATION_ENV['SERVICE_TOKEN'] ?? '';

interface GraphBody {
  to?: string;
  status?: string;
  text?: { body: string };
  interactive?: {
    body: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] };
  };
}
const graph = { sends: [] as GraphBody[] };
type Json = Record<string, unknown>;
const processRequests: Json[] = [];
const checkRequests: Json[] = [];
const detailsRequests: Json[] = [];

const randomPhone = (): string => `919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

function webhookFor(phone: string, message: Json): Buffer {
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

const text = (body: string): Json => ({ type: 'text', text: { body } });
const tap = (id: string): Json => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title: 'x' } },
});
const image = (mediaId: string): Json => ({
  type: 'image',
  image: { id: mediaId, mime_type: 'image/jpeg' },
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

const f = <T>(value: T | null, confidence = 0.95): { value: T | null; confidence: number } => ({
  value,
  confidence,
});

function medicine(name: string): Json {
  return {
    raw_text: f(`Tab. ${name} 1-0-1 x 5 days`),
    name: f(name),
    form: f('tablet'),
    strength: f('500 mg', 0.8),
    dose: f('1 tablet'),
    frequency_code: f('1-0-1'),
    frequency_per_day: f(2),
    timings: f(['morning', 'night'], 0.9),
    relation_to_food: f('after', 0.9),
    duration_days: f(5),
    as_needed: false,
    instructions: f(null, 0),
    low_confidence: false,
    validation_notes: [],
  };
}

function prescription(requestId: string, names: string[], report: Json): ProcessResponse {
  return {
    request_id: requestId,
    intent: 'prescription',
    emergency: false,
    emergency_category: null,
    extraction: {
      kind: 'prescription',
      is_prescription: true,
      image_quality: 'good',
      medicines: names.map(medicine),
      prescription_date: f(null, 0),
      overall_confidence: 0.9,
      notes_for_user: [],
      status: 'done',
    } as unknown as NonNullable<ProcessResponse['extraction']>,
    warnings: [],
    interactions: report as unknown as ProcessResponse['interactions'],
    reply: {
      language: 'en',
      text: `📋 I found ${names.length} medicine(s): ${names.join(', ')}`,
      buttons: [
        { id: 'rx:reminders:{document_id}', title: 'Set reminders' },
        { id: 'rx:generic:{document_id}', title: 'Generic medicines' },
        { id: 'rx:wrong:{document_id}', title: 'Something is wrong' },
      ],
    },
    meta: {
      model: 'fake-model',
      prompt_version: 'rx_extract_v1',
      latency_ms: 5,
      cost_usd: 0,
      trace_id: null,
      provider: 'fake',
      fallback_used: false,
    },
  };
}

const report = (over: Json): Json => ({
  findings: [],
  unchecked: [],
  resolved: [],
  checked_count: 1,
  database_ok: true,
  ...over,
});

describe('interaction checks (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: StorageService;
  const userIds: string[] = [];
  const INTERACTION_ID = randomUUID();
  /** Which prescription the mocked AI service answers next (set by each test). */
  let next: 'first' | 'second' = 'first';

  const post = (raw: Buffer): request.Test =>
    request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());
  const sendsTo = (phone: string): GraphBody[] => graph.sends.filter((body) => body.to === phone);
  const lastBody = (phone: string): string => {
    const last = sendsTo(phone).at(-1);
    return last?.text?.body ?? last?.interactive?.body.text ?? '';
  };

  const activeUser = async (): Promise<{ phone: string; userId: string }> => {
    const phone = randomPhone();
    const user = await prisma.user.create({
      data: {
        waPhoneHash: hashPhone(phone, PEPPER),
        waPhoneEnc: app.get(CryptoService).encrypt(phone),
        language: 'en',
        onboardingStep: 'done',
        consentAt: new Date(),
        consentVersion: 'v1',
      },
    });
    userIds.push(user.id);
    return { phone, userId: user.id };
  };

  const say = async (phone: string, message: Json, replies = 1): Promise<void> => {
    const before = sendsTo(phone).length;
    await post(webhookFor(phone, message)).expect(200);
    await waitFor(() => sendsTo(phone).length >= before + replies, 'replies');
    await sleep(200);
  };

  const mockImage = (mediaId: string, content: Buffer): void => {
    nock(GRAPH)
      .get(`/v21.0/${mediaId}`)
      .reply(200, {
        url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId}`,
        mime_type: 'image/jpeg',
        file_size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        id: mediaId,
      });
    nock('https://lookaside.fbsbx.com')
      .get('/whatsapp_business/attachments/')
      .query({ mid: mediaId })
      .reply(200, content, {
        'content-type': 'image/jpeg',
        'content-length': String(content.length),
      });
  };

  /** The user sends a prescription photo: acknowledgement + reply (+ the details follow-up). */
  const photo = async (phone: string, replies: number): Promise<void> => {
    const mediaId = `media-${randomUUID().slice(0, 8)}`;
    mockImage(mediaId, Buffer.from('fake-jpeg-bytes'));
    await say(phone, image(mediaId), replies);
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ...INTEGRATION_ENV,
      WORKERS_ENABLED: 'true',
      DEV_ECHO_BOT: 'false',
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

    nock(AI)
      .persist()
      .post('/v1/process')
      .matchHeader('x-service-token', TOKEN)
      .reply((_uri, body) => {
        const requestBody = body as {
          request_id: string;
          context: { active_medications: { medication_id: string; salt_key: string | null }[] };
        };
        processRequests.push(requestBody);
        if (next === 'first') {
          // Dolo (paracetamol) + Warfarin: nothing stored yet, nothing to warn about.
          return [
            200,
            prescription(
              requestBody.request_id,
              ['Dolo 650', 'Warfarin 5'],
              report({
                resolved: [
                  { ref: 'rx:0', salt_key: 'paracetamol' },
                  { ref: 'rx:1', salt_key: 'warfarin' },
                ],
                checked_count: 2,
              }),
            ),
          ];
        }
        // Second prescription: Crocin (paracetamol). Findings are built from the ids the gateway sent.
        const stored = requestBody.context.active_medications;
        const dolo = stored.find((m) => m.salt_key === 'paracetamol');
        const warfarin = stored.find((m) => m.salt_key === 'warfarin');
        const findings = [
          {
            type: 'duplicate_ingredient',
            severity: null,
            salt_a: 'paracetamol',
            salt_b: 'paracetamol',
            medication_refs: ['rx:0', dolo?.medication_id],
            labels: ['Crocin 500', 'Dolo 650'],
            management_key: 'duplicate_overdose',
            involves_new: true,
            hi_reviewed: false,
          },
          {
            type: 'interaction',
            severity: 'moderate',
            salt_a: 'paracetamol',
            salt_b: 'warfarin',
            medication_refs: ['rx:0', warfarin?.medication_id],
            labels: ['Crocin 500', 'Warfarin 5'],
            interaction_id: INTERACTION_ID,
            effect_code: 'increased_drug_level',
            management_key: 'moderate',
            involves_new: true,
            hi_reviewed: false,
          },
        ];
        return [
          200,
          prescription(
            requestBody.request_id,
            ['Crocin 500'],
            report({
              findings,
              resolved: [{ ref: 'rx:0', salt_key: 'paracetamol' }],
              checked_count: 3,
            }),
          ),
        ];
      });

    nock(AI)
      .persist()
      .post('/v1/interaction-details')
      .matchHeader('x-service-token', TOKEN)
      .reply((_uri, body) => {
        const requestBody = body as { request_id: string };
        detailsRequests.push(requestBody);
        return [
          200,
          {
            request_id: requestBody.request_id,
            reply: { language: 'en', text: 'IX-DETAILS-TEXT' },
          },
        ];
      });

    nock(AI)
      .persist()
      .post('/v1/interaction-check')
      .matchHeader('x-service-token', TOKEN)
      .reply((_uri, body) => {
        const requestBody = body as {
          request_id: string;
          medications: { medication_id: string; salt_key: string | null }[];
        };
        checkRequests.push(requestBody);
        const dolo = requestBody.medications.find((m) => m.salt_key === 'paracetamol');
        const croc = requestBody.medications.filter((m) => m.salt_key === 'paracetamol');
        return [
          200,
          {
            request_id: requestBody.request_id,
            interactions: report({
              findings: [
                {
                  type: 'duplicate_ingredient',
                  severity: null,
                  salt_a: 'paracetamol',
                  salt_b: 'paracetamol',
                  medication_refs: croc.map((m) => m.medication_id),
                  labels: ['Crocin 500', 'Dolo 650'],
                  management_key: 'duplicate_overdose',
                  involves_new: true,
                  hi_reviewed: false,
                },
              ],
              checked_count: requestBody.medications.length,
            }),
            reply: { language: 'en', text: dolo ? 'CHECK-RESULT-TEXT' : 'NO-DOLO' },
          },
        ];
      });

    app = (await createApp()) as INestApplication<App>;
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    await prisma.interaction.create({
      data: {
        id: INTERACTION_ID,
        saltA: 'paracetamol',
        saltB: 'warfarin',
        severity: 'moderate',
        summary: 'int test',
        source: 'int-test',
        effectCode: 'increased_drug_level',
      },
    });
  });

  afterAll(async () => {
    for (const id of userIds) await storage.deletePrefix(`media/${id}/`);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.interaction.deleteMany({ where: { id: INTERACTION_ID } });
    await app.close();
    nock.cleanAll();
    nock.enableNetConnect();
    process.env['WORKERS_ENABLED'] = 'false';
  });

  it('two prescriptions with the same salt: the second gets a stored duplicate warning', async () => {
    const { phone, userId } = await activeUser();

    // Day 1: Dolo 650 + Warfarin 5: nothing to warn about, no details message.
    next = 'first';
    await photo(phone, 2); // acknowledgement + reply
    await sleep(300);
    expect(sendsTo(phone)).toHaveLength(2);
    expect(await prisma.medicationWarning.count({ where: { userId } })).toBe(0);
    const day1 = await prisma.medication.findMany({
      where: { userId },
      orderBy: { rawName: 'asc' },
    });
    // `salt_key` is exactly what the interaction checker resolved (not the raw catalog match)
    expect(day1.map((m) => [m.rawName, m.saltKey])).toEqual([
      ['Dolo 650', 'paracetamol'],
      ['Warfarin 5', 'warfarin'],
    ]);

    // Day 2: another doctor's prescription: Crocin 500.
    next = 'second';
    await photo(phone, 3); // acknowledgement + reply + "Interaction details" follow-up
    const second = processRequests.at(-1) as {
      context: { active_medications: Record<string, unknown>[] };
    };
    // The gateway sent ALL stored medicines of ALL prescriptions, with ids and salt keys.
    expect(second.context.active_medications).toHaveLength(2);
    expect(second.context.active_medications.map((m) => m['salt_key']).sort()).toEqual([
      'paracetamol',
      'warfarin',
    ]);
    expect(
      second.context.active_medications.every((m) => typeof m['medication_id'] === 'string'),
    ).toBe(true);

    const warnings = await prisma.medicationWarning.findMany({
      where: { userId },
      orderBy: { type: 'asc' },
    });
    expect(warnings.map((w) => [w.type, w.saltA, w.saltB, w.severity, w.status])).toEqual([
      ['interaction', 'paracetamol', 'warfarin', 'moderate', 'active'],
      ['duplicate_ingredient', 'paracetamol', 'paracetamol', null, 'active'],
    ]);
    const meds = await prisma.medication.findMany({ where: { userId } });
    const crocin = meds.find((m) => m.rawName === 'Crocin 500');
    expect(crocin?.saltKey).toBe('paracetamol');
    const dup = warnings.find((w) => w.type === 'duplicate_ingredient');
    expect(dup?.medicationIds).toHaveLength(2);
    expect(dup?.medicationIds).toContain(crocin?.id);
    expect(warnings.find((w) => w.type === 'interaction')?.interactionId).toBe(INTERACTION_ID);

    // The main reply keeps its three buttons; the details button follows in a message of its own.
    const doc2 = await prisma.document.findFirstOrThrow({
      where: { userId, medications: { some: { rawName: 'Crocin 500' } } },
    });
    const sends = sendsTo(phone);
    const followUp = sends.at(-1)?.interactive;
    expect(followUp?.action.buttons).toEqual([
      { type: 'reply', reply: { id: `ix:details:${doc2.id}`, title: 'Interaction details' } },
    ]);
    const main = sends.at(-2)?.interactive;
    expect(main?.action.buttons.map((b) => b.reply.id)).toEqual([
      `rx:reminders:${doc2.id}`,
      `rx:generic:${doc2.id}`,
      `rx:wrong:${doc2.id}`,
    ]);
  });

  it('the same finding is never stored twice (a repeated check keeps one active warning)', async () => {
    const { phone, userId } = await activeUser();
    next = 'first';
    await photo(phone, 2);
    next = 'second';
    await photo(phone, 3);
    // A third prescription with the same pair: no new rows for the same (type, salts).
    await photo(phone, 3);
    const rows = await prisma.medicationWarning.findMany({
      where: { userId, status: 'active' },
      orderBy: { type: 'asc' },
    });
    expect(rows.map((w) => w.type)).toEqual(['interaction', 'duplicate_ingredient']);
  });

  it('the details button renders the stored warnings; a foreign document id is refused neutrally', async () => {
    const { phone, userId } = await activeUser();
    next = 'first';
    await photo(phone, 2);
    next = 'second';
    await photo(phone, 3);
    const doc2 = await prisma.document.findFirstOrThrow({
      where: { userId, medications: { some: { rawName: 'Crocin 500' } } },
    });

    await say(phone, tap(`ix:details:${doc2.id}`));
    expect(lastBody(phone)).toBe('IX-DETAILS-TEXT');
    const sent = detailsRequests.at(-1) as {
      warnings: { type: string; salt_a: string; salt_b: string; labels: string[] }[];
    };
    expect(sent.warnings.map((w) => [w.type, w.salt_a, w.salt_b]).sort()).toEqual([
      ['duplicate_ingredient', 'paracetamol', 'paracetamol'],
      ['interaction', 'paracetamol', 'warfarin'],
    ]);
    expect(sent.warnings.find((w) => w.type === 'duplicate_ingredient')?.labels.sort()).toEqual([
      'Crocin 500',
      'Dolo 650',
    ]);

    // Another user's document: the same neutral answer as an unknown one, nothing revealed.
    const other = await activeUser();
    const before = detailsRequests.length;
    await say(other.phone, tap(`ix:details:${doc2.id}`));
    expect(lastBody(other.phone)).toContain('could not find');
    expect(detailsRequests).toHaveLength(before);
  });

  it('MEDS marks the medicines of an active warning', async () => {
    const { phone } = await activeUser();
    next = 'first';
    await photo(phone, 2);
    next = 'second';
    await photo(phone, 3);
    await say(phone, text('MEDS'));
    const list = lastBody(phone);
    expect(list).toContain('⚠️ Dolo 650');
    expect(list).toContain('⚠️ Crocin 500');
    expect(list).toContain('⚠️ Warfarin 5');
    expect(list).toContain('send CHECK');
  });

  it('CHECK re-runs the check on ALL stored medicines and keeps one active warning', async () => {
    const { phone, userId } = await activeUser();
    next = 'first';
    await photo(phone, 2);
    next = 'second';
    await photo(phone, 3);

    await say(phone, text('CHECK'), 2); // result + the details button
    const sent = checkRequests.at(-1) as { medications: unknown[] };
    expect(sent.medications).toHaveLength(3);
    const sends = sendsTo(phone);
    expect(sends.at(-2)?.text?.body).toBe('CHECK-RESULT-TEXT');
    expect(sends.at(-1)?.interactive?.action.buttons[0]?.reply.id).toBe('ix:details:all');
    const active = await prisma.medicationWarning.findMany({
      where: { userId, status: 'active' },
    });
    // CHECK's report only contains the duplicate: the pair that no longer shows up is resolved.
    expect(active.map((w) => w.type)).toEqual(['duplicate_ingredient']);
    expect(await prisma.medicationWarning.count({ where: { userId, status: 'resolved' } })).toBe(1);
  });

  it('CHECK with fewer than two medicines explains what is needed and calls no one', async () => {
    const { phone } = await activeUser();
    const before = checkRequests.length;
    await say(phone, text('CHECK'));
    expect(lastBody(phone)).toContain('at least two active medicines');
    expect(checkRequests).toHaveLength(before);
  });

  it('"Something is wrong" switches the prescription off and resolves its warnings', async () => {
    const { phone, userId } = await activeUser();
    next = 'first';
    await photo(phone, 2);
    next = 'second';
    await photo(phone, 3);
    const doc2 = await prisma.document.findFirstOrThrow({
      where: { userId, medications: { some: { rawName: 'Crocin 500' } } },
    });
    expect(await prisma.medicationWarning.count({ where: { userId, status: 'active' } })).toBe(2);

    await say(phone, tap(`rx:wrong:${doc2.id}`));
    expect(await prisma.medicationWarning.count({ where: { userId, status: 'active' } })).toBe(0);
    expect(await prisma.medicationWarning.count({ where: { userId, status: 'resolved' } })).toBe(2);
  });

  it('DELETE erases the warnings with everything else', async () => {
    const { phone, userId } = await activeUser();
    next = 'first';
    await photo(phone, 2);
    next = 'second';
    await photo(phone, 3);
    expect(await prisma.medicationWarning.count({ where: { userId } })).toBe(2);
    await prisma.user.delete({ where: { id: userId } }); // the same cascade the erasure job uses
    expect(await prisma.medicationWarning.count({ where: { userId } })).toBe(0);
    // the shared interaction row stays (it is catalog data)
    expect(await prisma.interaction.count({ where: { id: INTERACTION_ID } })).toBe(1);
    await say(phone, text('hello')).catch(() => undefined);
  });
});
