import type { ExecutionContext } from '@nestjs/common';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import sharp from 'sharp';

import type { AiClient } from '../ai-client/ai-client';
import type { ProcessResponse } from '../ai-client/types';
import type { StorageService } from '../common/storage/storage.service';
import type { BudgetService } from '../limits/budget.service';
import { InMemoryWindowStore } from '../limits/sliding-window';
import { MetricsService } from '../telemetry/metrics.service';
import type { DemoCacheService } from './demo-cache.service';
import { DemoKeyGuard } from './demo-key.guard';
import { DemoError, DemoService } from './demo.service';
import { sanitizeUpload, sniffMime, UnsupportedUploadError } from './image-sanitizer';
import { TurnstileService } from './turnstile.service';

const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function context(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('DemoKeyGuard', () => {
  it('404s when the demo is not configured (the routes do not exist)', () => {
    expect(() => new DemoKeyGuard({ DEMO_API_KEY: undefined }).canActivate(context({}))).toThrow(
      NotFoundException,
    );
  });
  it('401s without or with a wrong key, accepts the right one', () => {
    const guard = new DemoKeyGuard({ DEMO_API_KEY: 'k'.repeat(20) });
    expect(() => guard.canActivate(context({}))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context({ 'x-demo-key': 'nope' }))).toThrow(
      UnauthorizedException,
    );
    expect(guard.canActivate(context({ 'x-demo-key': 'k'.repeat(20) }))).toBe(true);
  });
});

describe('image sanitizer', () => {
  it('sniffs the real type, not the claimed one', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('MZ\x90\x00 an executable'))).toBeNull();
    expect(sniffMime(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });

  it('re-encodes an image as a new JPEG without EXIF', async () => {
    const withExif = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#fff' },
    })
      .withExif({ IFD0: { Copyright: 'SECRET-OWNER', ImageDescription: 'GPS home' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    expect(withExif.includes(Buffer.from('SECRET-OWNER'))).toBe(true);

    const clean = await sanitizeUpload(withExif);
    expect(clean.mime).toBe('image/jpeg');
    expect(clean.bytes.includes(Buffer.from('SECRET-OWNER'))).toBe(false);
    expect((await sharp(clean.bytes).metadata()).exif).toBeUndefined();
  });

  it('scales large images down and rejects garbage and truncated images', async () => {
    const big = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: '#eee' },
    })
      .png()
      .toBuffer();
    const out = await sanitizeUpload(big);
    expect((await sharp(out.bytes).metadata()).width).toBe(2000);
    await expect(sanitizeUpload(Buffer.from('hello world'))).rejects.toBeInstanceOf(
      UnsupportedUploadError,
    );
    await expect(sanitizeUpload(big.subarray(0, 40))).rejects.toBeInstanceOf(
      UnsupportedUploadError,
    );
  });

  it('passes a PDF through unchanged', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    const out = await sanitizeUpload(pdf);
    expect(out.mime).toBe('application/pdf');
    expect(out.bytes).toBe(pdf);
  });
});

describe('TurnstileService', () => {
  const build = (env: Partial<ConstructorParameters<typeof TurnstileService>[0]>) =>
    new TurnstileService(
      { NODE_ENV: 'test', TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SKIP: false, ...env },
      logger as never,
    );

  afterEach(() => jest.restoreAllMocks());

  it('is open without a secret outside production, closed in production', async () => {
    expect(await build({}).verify(undefined)).toBe('ok');
    expect(await build({ NODE_ENV: 'production' }).verify('tok')).toBe('unavailable');
  });

  it('verifies the token with Cloudflare', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false })))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const service = build({ TURNSTILE_SECRET_KEY: 'secret' });
    expect(await service.verify('good')).toBe('ok');
    expect(await service.verify('bad')).toBe('failed');
    expect(await service.verify('x')).toBe('unavailable');
    expect(await service.verify(undefined)).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function response(overrides: Partial<ProcessResponse> = {}): ProcessResponse {
  return {
    request_id: 'r',
    intent: 'prescription',
    emergency: false,
    warnings: [],
    reply: { language: 'en', text: 'hello', buttons: [] },
    meta: { prompt_version: 'v', latency_ms: 10, cost_usd: 0.02 },
    debug_trace: [{ node: 'classify', latency_ms: 5, status: 'ok' }],
    ...overrides,
  } as ProcessResponse;
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 30, height: 30, channels: 3, background: '#fff' } })
    .jpeg()
    .toBuffer();
}

function setup(opts: { exhausted?: boolean; turnstile?: 'ok' | 'failed' | 'unavailable' } = {}) {
  const store = new InMemoryWindowStore();
  const ai = { processDemo: jest.fn().mockResolvedValue(response()) };
  const storage = {
    putStream: jest.fn().mockResolvedValue(undefined),
    getPresignedUrl: jest.fn().mockResolvedValue('http://s3/presigned'),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const budget = {
    demoSnapshot: jest.fn().mockResolvedValue({ exhausted: opts.exhausted ?? false, spentUsd: 0 }),
    recordDemo: jest.fn().mockResolvedValue(undefined),
    snapshot: jest.fn().mockResolvedValue({ state: 'normal', spentUsd: 0, ratio: 0 }),
  };
  const cache = {
    get: jest
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(id === 'rx_clean' ? { ...response(), cached: undefined } : null),
      ),
  };
  const turnstile = { verify: jest.fn().mockResolvedValue(opts.turnstile ?? 'ok') };
  const service = new DemoService(
    { DEMO_RL_PER_HOUR: 2, DEMO_RL_PER_DAY: 3, DEMO_MAX_UPLOAD_MB: 1, PHONE_HASH_PEPPER: 'pepper' },
    store,
    cache as unknown as DemoCacheService,
    budget as unknown as BudgetService,
    turnstile as unknown as TurnstileService,
    storage as unknown as StorageService,
    ai as unknown as AiClient,
    new MetricsService(),
    logger as never,
  );
  return { service, ai, storage, budget, turnstile, cache };
}

describe('DemoService', () => {
  it('serves a sample from the cache without any model call, upload or captcha', async () => {
    const s = setup({ exhausted: true });
    const result = await s.service.sample('rx_clean', 'en', 'iphash');
    expect(result.cached).toBe(true);
    expect(result.uploads_enabled).toBe(false);
    expect(s.ai.processDemo).not.toHaveBeenCalled();
    expect(s.storage.putStream).not.toHaveBeenCalled();
    expect(s.turnstile.verify).not.toHaveBeenCalled();
  });

  it('404s a sample that has no cached answer', async () => {
    const s = setup();
    await expect(s.service.sample('lab_critical', 'hi', 'iphash')).rejects.toMatchObject({
      code: 'sample_unavailable',
    });
  });

  it('processes an upload under demo/, asks for the trace, records cost and deletes the file', async () => {
    const s = setup();
    const result = await s.service.upload({
      file: await jpeg(),
      language: 'en',
      turnstileToken: 't',
      ipHash: 'a',
    });
    expect(result.cached).toBe(false);
    expect(result.debug_trace).toHaveLength(1);
    const key = (s.storage.putStream.mock.calls[0] as [{ key: string }])[0].key;
    expect(key).toMatch(/^demo\/demo-[0-9a-f-]+\.jpg$/);
    const request = s.ai.processDemo.mock.calls[0]?.[0] as ProcessResponse & {
      options: { include_trace: boolean };
      user: Record<string, unknown>;
    };
    expect(request.options.include_trace).toBe(true);
    expect(request.user).toEqual({ language: 'en', age: null, sex: null });
    expect(s.budget.recordDemo).toHaveBeenCalledWith(0.02);
    expect(s.storage.deleteObject).toHaveBeenCalledWith(key);
  });

  it('still deletes the upload when the AI service fails', async () => {
    const s = setup();
    s.ai.processDemo.mockRejectedValueOnce(new Error('down'));
    await expect(
      s.service.upload({ file: await jpeg(), language: 'hi', turnstileToken: 't', ipHash: 'a' }),
    ).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(s.storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('rate limits uploads per IP (hourly) and tells when to retry', async () => {
    const s = setup();
    const file = await jpeg();
    const call = (ip: string) =>
      s.service.upload({ file, language: 'hi', turnstileToken: 't', ipHash: ip });
    await call('a');
    await call('a');
    const error = await call('a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoError);
    expect(error).toMatchObject({ code: 'rate_limited' });
    expect((error as DemoError).retryAfterS).toBeGreaterThan(0);
    await expect(call('b')).resolves.toBeDefined();
  });

  it('refuses uploads (not samples) once the demo budget is spent', async () => {
    const s = setup({ exhausted: true });
    await expect(
      s.service.upload({ file: await jpeg(), language: 'hi', turnstileToken: 't', ipHash: 'a' }),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(s.ai.processDemo).not.toHaveBeenCalled();
    await expect(s.service.sample('rx_clean', 'hi', 'a')).resolves.toBeDefined();
  });

  it('rejects a failed captcha, an unsupported file and an oversized file before any model call', async () => {
    const bad = setup({ turnstile: 'failed' });
    await expect(
      bad.service.upload({ file: await jpeg(), language: 'hi', turnstileToken: 'x', ipHash: 'a' }),
    ).rejects.toMatchObject({ code: 'captcha_failed' });
    const ok = setup();
    await expect(
      ok.service.upload({
        file: Buffer.from('not an image'),
        language: 'hi',
        turnstileToken: 't',
        ipHash: 'a',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_file' });
    await expect(
      ok.service.upload({
        file: Buffer.alloc(2 * 1024 * 1024),
        language: 'hi',
        turnstileToken: 't',
        ipHash: 'a',
      }),
    ).rejects.toMatchObject({ code: 'file_too_large' });
    expect(bad.ai.processDemo).not.toHaveBeenCalled();
    expect(ok.ai.processDemo).not.toHaveBeenCalled();
  });

  it('never stores the visitor address: only a keyed hash', () => {
    const { service } = setup();
    const hash = service.hashIp('203.0.113.7');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('203');
    expect(service.hashIp('203.0.113.7')).toBe(hash);
  });
});
