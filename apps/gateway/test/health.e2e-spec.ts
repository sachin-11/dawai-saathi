import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      SERVICE_TOKEN: 'test-service-token',
      AI_SERVICE_URL: 'http://localhost:8000',
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live → 200 { status: "ok" }', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
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
