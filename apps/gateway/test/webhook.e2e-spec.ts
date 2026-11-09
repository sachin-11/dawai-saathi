import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { validateEnv } from '../src/config/env.schema';

import {
  OFFLINE_ENV,
  WA_PHONE_NUMBER_ID,
  WA_VERIFY_TOKEN,
  createApp,
  fixtureBuffer,
  signedHeaders,
} from './support/webhook-test-utils';

const URL = '/webhook/whatsapp';

describe('WhatsApp webhook (e2e, no infrastructure)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    Object.assign(process.env, OFFLINE_ENV);
    app = (await createApp()) as INestApplication<App>;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET verification', () => {
    const query = (overrides: Record<string, string> = {}): Record<string, string> => ({
      'hub.mode': 'subscribe',
      'hub.verify_token': WA_VERIFY_TOKEN,
      'hub.challenge': '1158201444',
      ...overrides,
    });

    it('echoes the challenge as plain text when the token matches', async () => {
      const res = await request(app.getHttpServer()).get(URL).query(query()).expect(200);
      expect(res.text).toBe('1158201444');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
    });

    it.each([
      ['wrong token', { 'hub.verify_token': 'nope' }],
      ['wrong mode', { 'hub.mode': 'unsubscribe' }],
      ['empty token', { 'hub.verify_token': '' }],
    ])('403 for %s', async (_name, overrides) => {
      const res = await request(app.getHttpServer()).get(URL).query(query(overrides)).expect(403);
      expect(res.text).not.toContain('1158201444');
    });

    it('403 when parameters are missing', async () => {
      await request(app.getHttpServer()).get(URL).expect(403);
      await request(app.getHttpServer()).get(URL).query({ 'hub.mode': 'subscribe' }).expect(403);
    });

    it('403 when a parameter is repeated (array) instead of crashing', async () => {
      await request(app.getHttpServer())
        .get(`${URL}?hub.mode=subscribe&hub.verify_token=a&hub.verify_token=b&hub.challenge=1`)
        .expect(403);
    });
  });

  describe('POST signature', () => {
    const text = fixtureBuffer('text');

    it('401 without a signature header', async () => {
      const res = await request(app.getHttpServer())
        .post(URL)
        .set('Content-Type', 'application/json')
        .send(text.toString())
        .expect(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('401 with a wrong signature', async () => {
      await request(app.getHttpServer())
        .post(URL)
        .set({ ...signedHeaders(text), 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` })
        .send(text.toString())
        .expect(401);
    });

    it('401 when the body was changed after signing', async () => {
      await request(app.getHttpServer())
        .post(URL)
        .set(signedHeaders(text))
        .send(`${text.toString()} `)
        .expect(401);
    });

    it('401 when the JSON is equivalent but the bytes differ (raw body is what counts)', async () => {
      const pretty = JSON.stringify(JSON.parse(text.toString()), null, 4);
      await request(app.getHttpServer())
        .post(URL)
        .set(signedHeaders(text))
        .send(pretty)
        .expect(401);
    });
  });

  describe('POST with a valid signature', () => {
    const post = (raw: Buffer | string): request.Test =>
      request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());

    it('500 for a status update when the database is unreachable (Meta retries it)', async () => {
      // Statuses update the delivery state of our outbound messages (M3), so they need the DB.
      await post(fixtureBuffer('status')).expect(500);
    });

    it('200 for a status type we do not model (no database access needed)', async () => {
      const raw = JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: WA_PHONE_NUMBER_ID },
                  statuses: [{ id: 'wamid.X', status: 'warning' }],
                },
              },
            ],
          },
        ],
      });
      const res = await post(raw).expect(200);
      expect(res.body).toEqual({ status: 'received' });
    });

    it('200 for another phone_number_id (ignored, so Meta does not retry)', async () => {
      const res = await post(fixtureBuffer('foreign')).expect(200);
      expect(res.body).toEqual({ status: 'received' });
    });

    it.each(['{}', '{"entry":"x"}', '{"entry":[{"changes":[{}]}]}'])(
      '200 for a well-signed but meaningless body %s',
      async (raw) => {
        await post(raw).expect(200);
      },
    );

    it('500 (so Meta retries later) when the database is unreachable', async () => {
      const res = await post(fixtureBuffer('text')).expect(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
      // The generic error must not leak driver details or the phone number.
      expect(res.text).not.toMatch(/127\.0\.0\.1|9999999999|prisma/i);
    });

    it('413 for a body over the 1 MB limit', async () => {
      const huge = JSON.stringify({ entry: [], padding: 'x'.repeat(1_100_000) });
      await post(huge).expect(413);
    });
  });
});

describe('WhatsApp webhook rate limit (e2e)', () => {
  it('answers 429 after too many requests from one client', async () => {
    Object.assign(process.env, OFFLINE_ENV, { WEBHOOK_RATE_LIMIT_PER_MIN: '300' });
    const app = (await createApp()) as INestApplication<App>;
    try {
      const server = app.getHttpServer();
      const statuses: number[] = [];
      for (let i = 0; i < 305; i++) {
        const res = await request(server).get(URL).query({ 'hub.mode': 'subscribe' });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 300).every((status) => status === 403)).toBe(true);
      expect(statuses.slice(300)).toContain(429);
    } finally {
      delete process.env['WEBHOOK_RATE_LIMIT_PER_MIN'];
      await app.close();
    }
  });

  it('the limit is configurable: the default is far above real traffic (20 msg/s in the smoke test)', () => {
    expect(validateEnv({ ...OFFLINE_ENV }).WEBHOOK_RATE_LIMIT_PER_MIN).toBe(6000);
  });
});
