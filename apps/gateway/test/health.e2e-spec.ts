import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { NEST_APP_OPTIONS, configureApp } from '../src/app.setup';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERVICE_TOKEN: 'test-service-token',
      AI_SERVICE_URL: 'http://localhost:8000',
      // Nothing listens on port 1: the app must still boot (lazy connections) and /health/ready
      // must report the dependencies as failed. No Docker needed for this suite.
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/none',
      REDIS_URL: 'redis://127.0.0.1:1',
      S3_BUCKET: 'test-bucket',
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test-secret',
      WA_VERIFY_TOKEN: 'test-verify-token',
      WA_APP_SECRET: 'test-app-secret',
      WA_PHONE_NUMBER_ID: '100000000000001',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      PHONE_HASH_PEPPER: 'test-pepper-value',
      WORKERS_ENABLED: 'false',
      WA_ACCESS_TOKEN: 'test-access-token',
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app as unknown as NestExpressApplication);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live → 200 { status: "ok" }', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready → 503 with per-dependency status when infra is unreachable', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body).toEqual({
      status: 'degraded',
      checks: { db: 'fail', redis: 'fail', s3: 'fail' },
    });
    expect(JSON.stringify(res.body)).not.toContain('pass');
  });

  it('assigns a request id when none is sent', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates a safe incoming x-request-id', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', 'lb-abc.123')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('lb-abc.123');
  });

  it('replaces an unsafe incoming x-request-id', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', 'bad id <script>')
      .expect(200);
    expect(res.headers['x-request-id']).not.toBe('bad id <script>');
  });

  it('unknown route → 404 with consistent error shape', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    const { error } = res.body as {
      error: { status: number; code: string; message: string; request_id: string };
    };
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'request_id', 'status']);
    expect(error.status).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(typeof error.message).toBe('string');
    expect(error.request_id).toBe(res.headers['x-request-id']);
  });
});
