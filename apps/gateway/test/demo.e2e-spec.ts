import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getLoggerToken } from 'nestjs-pino';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { APP_CONFIG } from '../src/config/config.constants';
import { DemoCacheService } from '../src/demo/demo-cache.service';
import { DemoKeyGuard } from '../src/demo/demo-key.guard';
import { DemoController } from '../src/demo/demo.controller';
import { DemoService } from '../src/demo/demo.service';
import { TurnstileService } from '../src/demo/turnstile.service';
import { AiClient } from '../src/ai-client/ai-client';
import { StorageService } from '../src/common/storage/storage.service';
import { BudgetService } from '../src/limits/budget.service';
import { WINDOW_STORE } from '../src/limits/limits.constants';
import { InMemoryWindowStore } from '../src/limits/sliding-window';
import { MetricsService } from '../src/telemetry/metrics.service';
import { PinoLogger } from 'nestjs-pino';

const KEY = 'demo-key-0123456789abcdef';
const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('Demo API (e2e, services stubbed)', () => {
  let app: INestApplication<App>;
  let exhausted = false;
  const ai = {
    processDemo: jest.fn().mockResolvedValue({
      request_id: 'r',
      intent: 'prescription',
      emergency: false,
      warnings: [],
      reply: { language: 'en', text: 'hello', buttons: [] },
      meta: { prompt_version: 'v', latency_ms: 1, cost_usd: 0.01 },
      debug_trace: [],
    }),
  };
  const storage = {
    putStream: jest.fn().mockResolvedValue(undefined),
    getPresignedUrl: jest.fn().mockResolvedValue('http://s3/x'),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DemoController],
      providers: [
        DemoService,
        DemoKeyGuard,
        {
          provide: APP_CONFIG,
          useValue: {
            DEMO_API_KEY: KEY,
            DEMO_RL_PER_HOUR: 3,
            DEMO_RL_PER_DAY: 5,
            DEMO_MAX_UPLOAD_MB: 1,
            PHONE_HASH_PEPPER: 'pepper',
          },
        },
        { provide: WINDOW_STORE, useValue: new InMemoryWindowStore() },
        {
          provide: DemoCacheService,
          useValue: {
            get: (id: string) =>
              Promise.resolve(
                id === 'rx_clean'
                  ? {
                      intent: 'prescription',
                      reply: { language: 'hi', text: 'cached', buttons: [] },
                      warnings: [],
                      meta: { prompt_version: 'v', latency_ms: 1, cost_usd: 0 },
                    }
                  : null,
              ),
            available: () => Promise.resolve([{ id: 'rx_clean', languages: ['hi'] }]),
          },
        },
        {
          provide: BudgetService,
          useValue: {
            demoSnapshot: () => Promise.resolve({ exhausted, spentUsd: 0 }),
            recordDemo: jest.fn(),
            snapshot: () => Promise.resolve({ state: 'normal' }),
          },
        },
        { provide: TurnstileService, useValue: { verify: () => Promise.resolve('ok') } },
        { provide: StorageService, useValue: storage },
        { provide: AiClient, useValue: ai },
        MetricsService,
        { provide: PinoLogger, useValue: logger },
        { provide: getLoggerToken(AllExceptionsFilter.name), useValue: logger },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());

  it('rejects calls without the demo key (the browser can never call this directly)', async () => {
    await request(app.getHttpServer())
      .post('/demo/process')
      .field('sample_id', 'rx_clean')
      .expect(401);
    await request(app.getHttpServer())
      .post('/demo/process')
      .set('X-Demo-Key', 'wrong')
      .field('sample_id', 'rx_clean')
      .expect(401);
  });

  it('answers a bundled sample from the cache', async () => {
    const res = await request(app.getHttpServer())
      .post('/demo/process')
      .set('X-Demo-Key', KEY)
      .set('X-Demo-Client-Ip', '198.51.100.1')
      .field('sample_id', 'rx_clean')
      .field('language', 'hi')
      .expect(200);
    expect(res.body).toMatchObject({ cached: true, reply: { text: 'cached' } });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects unknown samples, bad languages and a missing file', async () => {
    const post = () => request(app.getHttpServer()).post('/demo/process').set('X-Demo-Key', KEY);
    await post().field('sample_id', '../../etc/passwd').expect(400);
    await post().field('sample_id', 'rx_clean').field('language', 'fr').expect(400);
    await post().field('language', 'hi').expect(400);
  });

  it('processes an upload, then rate limits the same IP with a machine code', async () => {
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const upload = () =>
      request(app.getHttpServer())
        .post('/demo/process')
        .set('X-Demo-Key', KEY)
        .set('X-Demo-Client-Ip', '198.51.100.9')
        .field('language', 'en')
        .attach('file', png, { filename: 'x.png', contentType: 'image/png' });
    for (let i = 0; i < 3; i++) {
      const ok = await upload().expect(200);
      expect(ok.body.cached).toBe(false);
    }
    const limited = await upload().expect(429);
    expect(limited.body.error).toMatchObject({ code: 'rate_limited' });
    expect(limited.body.error.retry_after_s).toBeGreaterThan(0);
    expect(storage.putStream).toHaveBeenCalledTimes(3);
  });

  it('returns budget_exhausted for uploads but still serves samples', async () => {
    exhausted = true;
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const res = await request(app.getHttpServer())
      .post('/demo/process')
      .set('X-Demo-Key', KEY)
      .set('X-Demo-Client-Ip', '198.51.100.77')
      .attach('file', png, { filename: 'x.png', contentType: 'image/png' })
      .expect(429);
    expect(res.body.error.code).toBe('budget_exhausted');
    await request(app.getHttpServer())
      .post('/demo/process')
      .set('X-Demo-Key', KEY)
      .field('sample_id', 'rx_clean')
      .expect(200);
    exhausted = false;
  });
});
