/**
 * M12 integration tests: a lab report photo from an active user -> AI service (mocked) -> `documents`
 * (kind lab_report) + `lab_results` rows -> reply with buttons; trends context for the next report;
 * "See all tests"; "Something wrong" (leaves the trends); REPORTS; a foreign document id; DELETE cascade.
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
const aiRequests: Array<{ request_id: string; context?: Record<string, unknown> }> = [];
const renderRequests: Array<Record<string, unknown>> = [];

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

/** One result as the AI service returns it (after normalisation and comparison). */
function result(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    raw_test_name: f('Haemoglobin'),
    value_raw: f('11.2'),
    unit: f('g/dL'),
    lab_ref_low: f(12),
    lab_ref_high: f(15.5),
    lab_ref_text: f('12.0 - 15.5'),
    lab_flag: f('L'),
    section: 'CBC',
    test_code: 'HB',
    value_num: 11.2,
    value_comparator: '=',
    value_canonical: 11.2,
    unit_canonical: 'g/dl',
    status: 'low',
    range_basis: 'printed',
    range_text: '12–15.5',
    category: null,
    needs_confirmation: false,
    trend: null,
    ...overrides,
  };
}

const REPORT_DATE = '2026-11-02';

function labResponse(requestId: string): ProcessResponse {
  return {
    request_id: requestId,
    intent: 'lab_report',
    emergency: false,
    emergency_category: null,
    extraction: {
      kind: 'lab_report',
      is_lab_report: true,
      image_quality: 'good',
      report_date: f(REPORT_DATE),
      patient_age: f(45),
      patient_sex: f('f'),
      results: [
        result({}),
        result({
          raw_test_name: f('Special Marker XYZ'),
          value_raw: f('12'),
          unit: f('U/L'),
          lab_ref_text: f('0 - 10'),
          lab_flag: f('H'),
          section: 'Other',
          test_code: null,
          value_num: 12,
          value_canonical: null,
          unit_canonical: null,
          status: 'high',
        }),
        result({
          raw_test_name: f('Platelet Count'),
          value_raw: f('2.5'),
          unit: f('lakhs/cumm'),
          test_code: 'PLT',
          value_num: 2.5,
          value_canonical: 250,
          unit_canonical: '10^3/ul',
          status: 'normal',
          lab_flag: f(null, 0),
        }),
      ],
      overall_confidence: 0.92,
      notes_for_user: [],
      status: 'done',
      has_critical: false,
      used_general_range: false,
      unknown_count: 0,
    } as unknown as NonNullable<ProcessResponse['extraction']>,
    warnings: [],
    reply: {
      language: 'en',
      text: '🧪 Your report (2 Nov 2026) — 3 tests:\n✅ 1 within the normal range\n⚠️ Outside the range:\n• Haemoglobin: 11.2 g/dL (lab range 12–15.5) — below the range',
      buttons: [
        { id: 'lab:all:{document_id}', title: 'See all tests' },
        { id: 'lab:wrong:{document_id}', title: 'Something wrong' },
      ],
    },
    meta: {
      model: 'fake-model',
      prompt_version: 'image_classify_v1,lab_extract_v1,lab_reply_v1',
      latency_ms: 5,
      cost_usd: 0,
      trace_id: null,
      provider: 'fake',
      fallback_used: false,
    },
  };
}

describe('lab report flow (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let storage: StorageService;
  const userIds: string[] = [];

  const post = (raw: Buffer): request.Test =>
    request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());
  const sendsTo = (phone: string): GraphBody[] => graph.sends.filter((body) => body.to === phone);

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

  /** A user sends a lab report photo; waits for the acknowledgement and the (mocked) AI reply. */
  const photo = async (phone: string, userId: string): Promise<{ id: string }> => {
    const before = await prisma.document.count({ where: { userId } });
    const mediaId = `media-${randomUUID().slice(0, 8)}`;
    mockImage(mediaId, Buffer.from('fake-jpeg-bytes'));
    await say(phone, image(mediaId), 2);
    const documents = await prisma.document.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    expect(documents).toHaveLength(before + 1);
    return documents[0] as { id: string };
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
        const requestBody = body as { request_id: string; context?: Record<string, unknown> };
        aiRequests.push(requestBody);
        return [200, labResponse(requestBody.request_id)];
      });
    nock(AI)
      .persist()
      .post('/v1/lab-render')
      .matchHeader('x-service-token', INTEGRATION_ENV['SERVICE_TOKEN'] ?? '')
      .reply((_uri, body) => {
        const requestBody = body as { request_id: string; mode: string } & Record<string, unknown>;
        renderRequests.push(requestBody);
        return [
          200,
          {
            request_id: requestBody.request_id,
            reply: { language: 'en', text: `LAB-RENDER-${requestBody.mode}`, buttons: [] },
          },
        ];
      });
    app = (await createApp()) as INestApplication<App>;
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
  });

  afterAll(async () => {
    for (const id of userIds) await storage.deletePrefix(`media/${id}/`);
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
    nock.cleanAll();
    nock.enableNetConnect();
    process.env['WORKERS_ENABLED'] = 'false';
  });

  it('a lab photo -> document + lab_results saved, reply buttons carry the document id', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);

    const stored = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(stored).toMatchObject({
      userId,
      kind: 'lab_report',
      status: 'done',
      promptVersion: 'image_classify_v1,lab_extract_v1,lab_reply_v1',
      model: 'fake-model',
    });
    expect(stored.s3Key).toMatch(new RegExp(`^media/${userId}/`));
    expect(await storage.statObject(stored.s3Key)).toBeDefined();
    // Age and sex stay on the document (data minimisation); the extraction has no name / id fields.
    expect(JSON.stringify(stored.extraction)).not.toMatch(/patient_name|doctor|phone|address/i);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).not.toHaveProperty(
      'age',
    );

    const rows = await prisma.labResult.findMany({
      where: { documentId: document.id },
      orderBy: { valueRaw: 'asc' },
    });
    expect(rows).toHaveLength(3);
    const hb = rows.find((r) => r.testCode === 'HB');
    expect(hb).toMatchObject({
      userId,
      valueRaw: '11.2',
      unitRaw: 'g/dL',
      unitCanonical: 'g/dl',
      status: 'low',
    });
    expect(Number(hb?.valueNumCanonical)).toBeCloseTo(11.2);
    expect(hb?.reportDate?.toISOString().slice(0, 10)).toBe(REPORT_DATE);
    // A test the catalog does not know keeps no code and no canonical value.
    expect(rows.find((r) => r.valueRaw === '12')).toMatchObject({
      testCode: null,
      valueNumCanonical: null,
      status: 'high',
    });

    const [ack, reply] = sendsTo(phone);
    expect(ack?.text?.body).toContain('Reading it now');
    expect(reply?.interactive?.action.buttons.map((b) => b.reply.id)).toEqual([
      `lab:all:${document.id}`,
      `lab:wrong:${document.id}`,
    ]);
    expect(reply?.interactive?.body.text).toContain('Your report');
  });

  it('the first photo sends no earlier results; the second one sends the first report as context', async () => {
    const { phone, userId } = await activeUser();
    aiRequests.length = 0;
    await photo(phone, userId);
    expect(aiRequests.at(-1)?.context?.['previous_lab_results']).toEqual([]);

    await photo(phone, userId);
    const previous = aiRequests.at(-1)?.context?.['previous_lab_results'] as Array<
      Record<string, unknown>
    >;
    expect(previous).toEqual(
      expect.arrayContaining([
        { test_code: 'HB', value: 11.2, unit: 'g/dl', report_date: REPORT_DATE },
        { test_code: 'PLT', value: 250, unit: '10^3/ul', report_date: REPORT_DATE },
      ]),
    );
    // Only canonical code / value / unit / date: no name, no raw text, no document id.
    expect(Object.keys(previous[0] ?? {}).sort()).toEqual([
      'report_date',
      'test_code',
      'unit',
      'value',
    ]);
    expect(previous.some((p) => p['test_code'] === null)).toBe(false);
  });

  it('a text message never triggers the lab-history query', async () => {
    const { phone } = await activeUser();
    aiRequests.length = 0;
    await say(phone, text('TSH 6.2 matlab kya?'));
    expect(aiRequests.at(-1)?.context).not.toHaveProperty('previous_lab_results');
  });

  it('"See all tests" sends the STORED extraction to the AI service and relays its text', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);
    renderRequests.length = 0;

    const before = sendsTo(phone).length;
    await say(phone, tap(`lab:all:${document.id}`));
    expect(sendsTo(phone)[before]?.text?.body).toBe('LAB-RENDER-all');
    expect(renderRequests).toHaveLength(1);
    const sent = renderRequests[0] as { language: string; extraction: { kind: string } };
    expect(sent.language).toBe('en');
    expect(sent.extraction.kind).toBe('lab_report');
  });

  it('"Something wrong" marks the document, audits without content and drops it from the trends', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);

    const before = sendsTo(phone).length;
    await say(phone, tap(`lab:wrong:${document.id}`));
    expect(sendsTo(phone)[before]?.text?.body).toContain('needs checking');
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status).toBe(
      'needs_review',
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId, action: 'lab_reported_wrong' },
    });
    expect(audit.metadata).toEqual({}); // an action only: no document id, no content

    aiRequests.length = 0;
    await photo(phone, userId);
    expect(aiRequests.at(-1)?.context?.['previous_lab_results']).toEqual([]);
  });

  it("another user's document id changes nothing and gets a neutral answer", async () => {
    const owner = await activeUser();
    const document = await photo(owner.phone, owner.userId);
    const stranger = await activeUser();

    renderRequests.length = 0;
    const before = sendsTo(stranger.phone).length;
    await say(stranger.phone, tap(`lab:wrong:${document.id}`));
    expect(sendsTo(stranger.phone)[before]?.text?.body).toContain('could not find');
    await say(stranger.phone, tap(`lab:all:${document.id}`));
    expect(renderRequests).toHaveLength(0);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status).toBe(
      'done',
    );
    expect(
      await prisma.auditLog.count({
        where: { userId: stranger.userId, action: 'lab_reported_wrong' },
      }),
    ).toBe(0);
  });

  it('a malformed document id is a neutral "not found"', async () => {
    const { phone } = await activeUser();
    const before = sendsTo(phone).length;
    await say(phone, tap('lab:all:not-a-uuid'));
    expect(sendsTo(phone)[before]?.text?.body).toContain('could not find');
  });

  it('REPORTS lists the reports with a button each; tapping one re-sends its summary', async () => {
    const { phone, userId } = await activeUser();
    const none = sendsTo(phone).length;
    await say(phone, text('reports'));
    expect(sendsTo(phone)[none]?.text?.body).toContain('no lab reports saved');

    const first = await photo(phone, userId);
    const second = await photo(phone, userId);
    const before = sendsTo(phone).length;
    await say(phone, text('reports'));
    const list = sendsTo(phone)[before]?.interactive;
    expect(list?.body.text).toContain('1. 2 Nov 2026 — 3 tests, 2 outside the range');
    expect(list?.action.buttons.map((b) => b.reply.id)).toEqual([
      `rep:show:${second.id}`,
      `rep:show:${first.id}`,
    ]);

    renderRequests.length = 0;
    const next = sendsTo(phone).length;
    await say(phone, tap(`rep:show:${first.id}`));
    expect(sendsTo(phone)[next]?.text?.body).toBe('LAB-RENDER-summary');
  });

  it('REPORTS is not available before consent', async () => {
    const phone = randomPhone();
    const user = await prisma.user.create({
      data: {
        waPhoneHash: hashPhone(phone, PEPPER),
        waPhoneEnc: app.get(CryptoService).encrypt(phone),
        language: 'en',
        onboardingStep: 'consent',
      },
    });
    userIds.push(user.id);
    const before = sendsTo(phone).length;
    await say(phone, text('reports'));
    expect(sendsTo(phone)[before]?.text?.body ?? '').not.toContain('lab reports');
  });

  it('DELETE removes the lab results with the user (cascade)', async () => {
    const { phone, userId } = await activeUser();
    const document = await photo(phone, userId);
    expect(await prisma.labResult.count({ where: { documentId: document.id } })).toBe(3);
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.labResult.count({ where: { userId } })).toBe(0);
    expect(await prisma.document.count({ where: { userId } })).toBe(0);
  });
});
