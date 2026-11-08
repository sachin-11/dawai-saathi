/**
 * M7 integration tests: a prescription photo from an active user -> AI service (mocked) -> `documents`
 * + `medications` rows -> reply with buttons; the "Something is wrong" button; MEDS; idempotency.
 * Real Postgres, Redis and MinIO (docker-compose.test.yml); WhatsApp Graph API and the AI service are
 * mocked with nock. Workers run for real.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import nock from 'nock';
import request from 'supertest';
import type { App } from 'supertest/types';

import type { ProcessResponse } from '../../src/ai-client/types';
import { CryptoService } from '../../src/common/crypto/crypto.service';
import { hashPhone } from '../../src/common/crypto/crypto.util';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { PrescriptionService } from '../../src/documents/prescription.service';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';
import { createApp, signedHeaders } from '../support/webhook-test-utils';

const GRAPH = 'https://graph.facebook.com';
const SEND_PATH = '/v21.0/100000000000001/messages';
const AI = INTEGRATION_ENV['AI_SERVICE_URL'] ?? 'http://localhost:8000';
const URL = '/webhook/whatsapp';
const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';

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
const aiRequests: Array<Record<string, unknown>> = [];
const detailsRequests: Array<Record<string, unknown>> = [];

function installGraphMock(): void {
  nock(GRAPH)
    .persist()
    .post(SEND_PATH)
    .reply((_uri, body) => {
      const payload = body as GraphBody;
      if (payload.status === 'read') return [200, { success: true }];
      graph.sends.push(payload);
      return [200, { messages: [{ id: `wamid.OUT${graph.sends.length}` }] }];
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
const tap = (id: string): Record<string, unknown> => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title: 'x' } },
});
const image = (mediaId: string): Record<string, unknown> => ({
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

/** A real row in `drugs` (created in beforeAll): medications.drug_id is a foreign key. */
const DRUG_ID = randomUUID();

const DOLO = {
  raw_text: f('Tab. Dolo 650 1-0-1 x 5 days'),
  name: f('Dolo 650'),
  form: f('tablet'),
  strength: f('650 mg', 0.8),
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
  match: {
    drug_id: DRUG_ID,
    brand_name: 'Dolo 650',
    salt_key: 'paracetamol',
    strength_key: '650mg',
    form_key: 'tablet',
    release_type: 'ir',
    score: 1,
    method: 'exact',
    candidates: [],
    strength_basis: 'brand_name',
    strength_conflict: false,
    form_conflict: false,
    ambiguous: false,
  },
  generic: {
    alternatives: [
      {
        drug_id: 'jan-1',
        brand_name: 'Paracetamol Tablets IP 650 mg',
        is_janaushadhi: true,
        price_per_unit: 1.5,
        pack_label: '10 tablet',
        pack_price: 15,
        approx_savings: 15,
        savings_basis: 'course',
      },
    ],
    price_source_date: '2026-01-01',
    savings_known: true,
  },
};
const UNREADABLE = {
  ...DOLO,
  raw_text: f('Tab. ??? 1-0-1', 0.3),
  name: f(null, 0.1),
  low_confidence: true,
};

function prescriptionResponse(requestId: string): ProcessResponse {
  return {
    request_id: requestId,
    intent: 'prescription',
    emergency: false,
    emergency_category: null,
    extraction: {
      kind: 'prescription',
      is_prescription: true,
      image_quality: 'good',
      medicines: [DOLO, UNREADABLE],
      prescription_date: f(null, 0),
      overall_confidence: 0.1,
      notes_for_user: [],
      status: 'needs_review',
    } as unknown as NonNullable<ProcessResponse['extraction']>,
    warnings: [{ type: 'low_confidence', detail: 'medicine 2: name not clear' }],
    // M11: `medications.salt_key` is the salt the interaction checker used, nothing else
    interactions: {
      findings: [],
      unchecked: [],
      resolved: [{ ref: 'rx:0', salt_key: 'paracetamol' }],
      checked_count: 1,
      database_ok: true,
    },
    reply: {
      language: 'en',
      text: '📋 I found 2 medicines in your prescription:\n\n1. Dolo 650 (tablet, 650 mg) — 1 tablet, morning and night, after food, for 5 days\n   💰 A cheaper option with the same salt is available.\n2. I could not read this medicine clearly. Please confirm with your pharmacist.',
      buttons: [
        { id: 'rx:reminders:{document_id}', title: 'Set reminders' },
        { id: 'rx:generic:{document_id}', title: 'Generic medicines' },
        { id: 'rx:wrong:{document_id}', title: 'Something is wrong' },
      ],
    },
    meta: {
      model: 'fake-model',
      prompt_version: 'image_classify_v1,rx_extract_v1,rx_compose_v1',
      latency_ms: 5,
      cost_usd: 0,
      trace_id: null,
      provider: 'fake',
      fallback_used: false,
    },
  };
}

describe('prescription flow (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: StorageService;
  const userIds: string[] = [];

  const post = (raw: Buffer): request.Test =>
    request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());
  const sendsTo = (phone: string): GraphBody[] => graph.sends.filter((body) => body.to === phone);

  const activeUser = async (
    language: 'hi' | 'en' = 'en',
  ): Promise<{ phone: string; userId: string }> => {
    const phone = randomPhone();
    const user = await prisma.user.create({
      data: {
        waPhoneHash: hashPhone(phone, PEPPER),
        waPhoneEnc: app.get(CryptoService).encrypt(phone),
        language,
        onboardingStep: 'done',
        consentAt: new Date(),
        consentVersion: 'v1',
      },
    });
    userIds.push(user.id);
    return { phone, userId: user.id };
  };

  const say = async (
    phone: string,
    message: Record<string, unknown>,
    replies = 1,
  ): Promise<void> => {
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

  /** A user sends a prescription photo; waits for the acknowledgement and the (mocked) AI reply. */
  const photo = async (phone: string, userId: string): Promise<{ id: string }> => {
    const mediaId = `media-${randomUUID().slice(0, 8)}`;
    mockImage(mediaId, Buffer.from('fake-jpeg-bytes'));
    await say(phone, image(mediaId), 2);
    return prisma.document.findFirstOrThrow({ where: { userId }, select: { id: true } });
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
    installGraphMock();
    nock(AI)
      .persist()
      .post('/v1/process')
      .matchHeader('x-service-token', INTEGRATION_ENV['SERVICE_TOKEN'] ?? '')
      .reply((_uri, body) => {
        const requestBody = body as { request_id: string } & Record<string, unknown>;
        aiRequests.push(requestBody);
        return [200, prescriptionResponse(requestBody.request_id)];
      });
    nock(AI)
      .persist()
      .post('/v1/generic-details')
      .matchHeader('x-service-token', INTEGRATION_ENV['SERVICE_TOKEN'] ?? '')
      .reply((_uri, body) => {
        const requestBody = body as { request_id: string } & Record<string, unknown>;
        detailsRequests.push(requestBody);
        return [
          200,
          {
            request_id: requestBody.request_id,
            reply: { language: 'en', text: 'GENERIC-DETAILS-TEXT', buttons: [] },
          },
        ];
      });
    app = (await createApp()) as INestApplication<App>;
    prisma = app.get(PrismaService);
    await prisma.drug.create({
      data: {
        id: DRUG_ID,
        brandName: 'Dolo 650',
        saltComposition: 'paracetamol',
        strength: '650mg',
        form: 'tablet',
        source: 'int-test',
        sourceRef: DRUG_ID,
      },
    });
    storage = app.get(StorageService);
  });

  afterAll(async () => {
    for (const id of userIds) await storage.deletePrefix(`media/${id}/`);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.drug.deleteMany({ where: { id: DRUG_ID } });
    await app.close();
    nock.cleanAll();
    nock.enableNetConnect();
    process.env['WORKERS_ENABLED'] = 'false';
  });

  it('a prescription photo -> document + medications saved, reply with buttons carrying the document id', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(stored).toMatchObject({
      userId,
      kind: 'prescription',
      status: 'needs_review',
      promptVersion: 'image_classify_v1,rx_extract_v1,rx_compose_v1',
      model: 'fake-model',
    });
    expect(Number(stored.overallConfidence)).toBeCloseTo(0.1);
    expect(stored.s3Key).toMatch(new RegExp(`^media/${userId}/`));
    expect(await storage.statObject(stored.s3Key)).toBeDefined();
    // The stored extraction has no PHI fields by construction.
    expect(JSON.stringify(stored.extraction)).not.toMatch(/patient|doctor|phone|address/i);

    const meds = await prisma.medication.findMany({
      where: { documentId: document.id },
      orderBy: { rawName: 'asc' },
    });
    expect(meds).toHaveLength(2);
    const dolo = meds.find((m) => m.rawName === 'Dolo 650');
    expect(dolo).toMatchObject({
      userId,
      strength: '650 mg',
      form: 'tablet',
      dose: '1 tablet',
      frequencyPerDay: 2,
      asNeeded: false,
      timings: ['08:00', '21:00'],
      relationToFood: 'after',
      durationDays: 5,
      active: true,
      salt: 'paracetamol',
      saltKey: 'paracetamol',
      strengthKey: '650mg',
      formKey: 'tablet',
      releaseType: 'ir',
      matchMethod: 'exact',
      drugId: DRUG_ID,
    });
    expect(Number(dolo?.matchScore)).toBe(1);
    // "x 5 days" starting today: the inclusive end date is 4 days after the start date.
    const spanMs = (dolo?.endDate?.getTime() ?? NaN) - (dolo?.startDate.getTime() ?? 0);
    expect(spanMs / (24 * 60 * 60 * 1000)).toBe(4);
    // The unreadable one is saved (the user was told about it) but never active.
    expect(meds.find((m) => m.rawName !== 'Dolo 650')).toMatchObject({ active: false });

    const [ack, reply] = sendsTo(phone);
    expect(ack?.text?.body).toContain('Reading it now');
    const buttons = reply?.interactive?.action.buttons.map((b) => b.reply.id);
    expect(buttons).toEqual([
      `rx:reminders:${document.id}`,
      `rx:generic:${document.id}`,
      `rx:wrong:${document.id}`,
    ]);
    expect(reply?.interactive?.body.text).toContain('Dolo 650');
  });

  it('the AI service got a presigned URL and no phone number or caption text', () => {
    const last = aiRequests.at(-1) as {
      input: { type: string; media_url: string; mime: string; text?: string };
    };
    expect(last.input.type).toBe('image');
    expect(last.input.media_url).toMatch(/^http:\/\/localhost:9100\//);
    expect(last.input.media_url).toContain('X-Amz-Signature');
    expect(JSON.stringify(aiRequests)).not.toMatch(/919\d{9}/);
  });

  it('reprocessing the same message does not duplicate the document or the medicines', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);
    const message = await prisma.message.findFirstOrThrow({
      where: { userId, direction: 'in' },
      select: { id: true },
    });
    const extraction = (await prisma.document.findUniqueOrThrow({ where: { id: document.id } }))
      .extraction as unknown as NonNullable<ProcessResponse['extraction']>;

    const service = app.get(PrescriptionService);
    const input = {
      userId,
      messageId: message.id,
      s3Key: 'media/x.jpg',
      extraction,
      meta: { model: 'm', prompt_version: 'p' },
    };
    const [a, b] = await Promise.all([service.save(input), service.save(input)]);
    expect(a.documentId).toBe(document.id);
    expect(b.documentId).toBe(document.id);
    expect(a.created || b.created).toBe(false);
    expect(await prisma.document.count({ where: { userId } })).toBe(1);
    expect(await prisma.medication.count({ where: { userId } })).toBe(2);
  });

  it('a failed read keeps a failed document but saves no medicines', async () => {
    const { userId } = await activeUser();
    const message = await prisma.message.create({
      data: {
        userId,
        direction: 'in',
        waMessageId: `wamid.F${randomUUID()}`,
        type: 'image',
      },
    });
    const extraction = {
      kind: 'prescription',
      is_prescription: true,
      image_quality: 'unreadable',
      medicines: [DOLO],
      prescription_date: f(null, 0),
      overall_confidence: 0,
      notes_for_user: [],
      status: 'failed',
    } as unknown as NonNullable<ProcessResponse['extraction']>;
    const saved = await app.get(PrescriptionService).save({
      userId,
      messageId: message.id,
      s3Key: 'media/x.jpg',
      extraction,
      meta: { model: null, prompt_version: 'p' },
    });
    expect(saved.status).toBe('failed');
    expect(await prisma.medication.count({ where: { userId } })).toBe(0);
  });

  it('MEDS lists the new active medicine (and not the unreadable one)', async () => {
    const { phone, userId } = await activeUser();
    await photo(phone, userId);
    const before = sendsTo(phone).length;
    await say(phone, text('meds'));
    const list = sendsTo(phone)[before]?.text?.body ?? '';
    expect(list).toContain('• Dolo 650 — 08:00, 21:00');
    expect(list.match(/•/g)).toHaveLength(1);
  });

  it('"Something is wrong" marks the document, deactivates its medicines and audits counts only', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);

    const before = sendsTo(phone).length;
    await say(phone, tap(`rx:wrong:${document.id}`));
    expect(sendsTo(phone)[before]?.text?.body).toContain('needs checking');

    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status).toBe(
      'needs_review',
    );
    expect(await prisma.medication.count({ where: { userId, active: true } })).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId, action: 'rx_reported_wrong' },
    });
    expect(audit.metadata).toEqual({ medications_deactivated: 1 });
  });

  it("another user's document id changes nothing and gets a neutral answer", async () => {
    const owner = await activeUser();
    const document = await photo(owner.phone, owner.userId);
    const stranger = await activeUser();

    const before = sendsTo(stranger.phone).length;
    await say(stranger.phone, tap(`rx:wrong:${document.id}`));
    expect(sendsTo(stranger.phone)[before]?.text?.body).toContain('could not find');
    expect(await prisma.medication.count({ where: { userId: owner.userId, active: true } })).toBe(
      1,
    );
    expect(
      await prisma.auditLog.count({
        where: { userId: stranger.userId, action: 'rx_reported_wrong' },
      }),
    ).toBe(0);
  });

  it('a malformed document id is a neutral "not found" and never reaches the database as a uuid', async () => {
    const { phone } = await activeUser();
    const before = sendsTo(phone).length;
    await say(phone, tap('rx:wrong:not-a-uuid'));
    expect(sendsTo(phone)[before]?.text?.body).toContain('could not find');
  });

  it('"Set reminders" shows the plan first and saves nothing until the user confirms (M10)', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);
    const before = sendsTo(phone).length;
    await say(phone, tap(`rx:reminders:${document.id}`));
    const summary = sendsTo(phone)[before];
    expect(summary?.interactive?.body.text).toContain('Dolo 650');
    expect(summary?.interactive?.action.buttons).toHaveLength(3);
    expect(await prisma.medication.count({ where: { userId, active: true } })).toBe(1);
    expect(await prisma.reminderSchedule.count({ where: { userId } })).toBe(0);
  });

  it('the reply carries the cheaper-option line, no price and no brand of the generic', async () => {
    const { phone, userId } = await activeUser();
    await photo(phone, userId);
    const reply = sendsTo(phone)[1]?.interactive?.body.text ?? '';
    expect(reply).toContain('💰 A cheaper option with the same salt is available.');
    expect(reply).not.toContain('₹');
    expect(reply).not.toContain('Paracetamol Tablets IP');
  });

  it('"Generic medicines" sends the STORED suggestions to the AI service and relays its text', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);
    detailsRequests.length = 0;

    const before = sendsTo(phone).length;
    await say(phone, tap(`rx:generic:${document.id}`));
    expect(sendsTo(phone)[before]?.text?.body).toBe('GENERIC-DETAILS-TEXT');

    expect(detailsRequests).toHaveLength(1);
    const request = detailsRequests[0] as {
      language: string;
      medicines: Array<{ name: string; generic: { alternatives: unknown[] } }>;
    };
    expect(request.language).toBe('en');
    // Only the readable medicine (the unreadable one was never matched); the snapshot is untouched.
    expect(request.medicines.map((m) => m.name)).toEqual(['Dolo 650']);
    expect(request.medicines[0]?.generic.alternatives).toHaveLength(1);
    expect(JSON.stringify(detailsRequests)).not.toMatch(/919\d{9}/);
  });

  it("someone else's document id never reaches the AI service", async () => {
    const owner = await activeUser();
    const document = await photo(owner.phone, owner.userId);
    const stranger = await activeUser();
    detailsRequests.length = 0;

    const before = sendsTo(stranger.phone).length;
    await say(stranger.phone, tap(`rx:generic:${document.id}`));
    expect(sendsTo(stranger.phone)[before]?.text?.body).toContain('could not find');
    expect(detailsRequests).toHaveLength(0);
  });

  it('a prescription read before M8 (no stored suggestions) gets an honest message', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    const extraction = JSON.parse(JSON.stringify(stored.extraction)) as {
      medicines: Array<Record<string, unknown>>;
    };
    for (const medicine of extraction.medicines) {
      delete medicine['match'];
      delete medicine['generic'];
    }
    await prisma.document.update({
      where: { id: document.id },
      data: { extraction: extraction as unknown as Prisma.InputJsonValue },
    });
    detailsRequests.length = 0;

    const before = sendsTo(phone).length;
    await say(phone, tap(`rx:generic:${document.id}`));
    expect(sendsTo(phone)[before]?.text?.body).toContain("don't have generic suggestions saved");
    expect(detailsRequests).toHaveLength(0);
  });

  it('deleting the user removes the documents and medications too', async () => {
    const { phone, userId } = await activeUser();
    await photo(phone, userId);
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.document.count({ where: { userId } })).toBe(0);
    expect(await prisma.medication.count({ where: { userId } })).toBe(0);
  });
});
