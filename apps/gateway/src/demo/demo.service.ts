import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AiClient } from '../ai-client/ai-client';
import { AiServiceError } from '../ai-client/ai-client.errors';
import { StorageService } from '../common/storage/storage.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { BudgetService } from '../limits/budget.service';
import { WINDOW_STORE } from '../limits/limits.constants';
import type { WindowStore } from '../limits/sliding-window';
import { MetricsService } from '../telemetry/metrics.service';
import { inSpan } from '../telemetry/trace-context';
import { type CachedDemoResponse, DemoCacheService } from './demo-cache.service';
import { DEMO_S3_PREFIX, type DemoLanguage, type DemoSampleId } from './demo.constants';
import { sanitizeUpload, UnsupportedUploadError } from './image-sanitizer';
import { TurnstileService } from './turnstile.service';

export type DemoErrorCode =
  | 'rate_limited'
  | 'budget_exhausted'
  | 'captcha_failed'
  | 'captcha_unavailable'
  | 'unsupported_file'
  | 'file_too_large'
  | 'sample_unavailable'
  | 'ai_unavailable';

export class DemoError extends HttpException {
  constructor(
    readonly code: DemoErrorCode,
    status: HttpStatus,
    readonly retryAfterS?: number,
  ) {
    super(
      { error: { code, status, ...(retryAfterS ? { retry_after_s: retryAfterS } : {}) } },
      status,
    );
  }
}

export interface DemoResult extends CachedDemoResponse {
  /** True when this answer was pre-computed (a bundled sample), not produced for this request. */
  cached: boolean;
  /** Uploads are off (budget spent or no captcha); bundled samples still work. */
  uploads_enabled: boolean;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SAMPLE_PER_HOUR = 120;
const PRESIGN_TTL_S = 300;

/**
 * The web demo. Everything that could go wrong with a PUBLIC endpoint is handled here:
 *  - samples come from the cache only (no model call, no upload, no captcha),
 *  - an upload is rate limited per IP, checked against its own budget, captcha-verified, magic-byte
 *    sniffed, EXIF-stripped, stored under `demo/` (deleted again right after, 24 h lifecycle as a
 *    backstop) and NEVER linked to a user or written to `documents` / `medications`,
 *  - the AI call uses DEMO_SERVICE_TOKEN and asks for `debug_trace` (names, timings, costs; no text).
 */
@Injectable()
export class DemoService {
  constructor(
    @Inject(APP_CONFIG)
    private readonly env: Pick<
      Env,
      'DEMO_RL_PER_HOUR' | 'DEMO_RL_PER_DAY' | 'DEMO_MAX_UPLOAD_MB' | 'PHONE_HASH_PEPPER'
    >,
    @Inject(WINDOW_STORE) private readonly windows: WindowStore,
    private readonly cache: DemoCacheService,
    private readonly budget: BudgetService,
    private readonly turnstile: TurnstileService,
    private readonly storage: StorageService,
    private readonly ai: AiClient,
    private readonly metrics: MetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DemoService.name);
  }

  /** A keyed hash of the client address: the IP itself is never stored or logged. */
  hashIp(ip: string): string {
    return createHmac('sha256', this.env.PHONE_HASH_PEPPER).update(`demo-ip:${ip}`).digest('hex');
  }

  async uploadsEnabled(): Promise<boolean> {
    return !(await this.budget.demoSnapshot()).exhausted;
  }

  async sample(id: DemoSampleId, language: DemoLanguage, ipHash: string): Promise<DemoResult> {
    await this.limit(`demo:sample:${ipHash}`, SAMPLE_PER_HOUR, HOUR_MS);
    const cached = await this.cache.get(id, language);
    if (!cached) {
      this.count('sample_unavailable');
      throw new DemoError('sample_unavailable', HttpStatus.NOT_FOUND);
    }
    this.count('sample');
    return { ...cached, cached: true, uploads_enabled: await this.uploadsEnabled() };
  }

  async upload(input: {
    file: Buffer;
    language: DemoLanguage;
    turnstileToken: string | undefined;
    ipHash: string;
  }): Promise<DemoResult> {
    const maxBytes = Math.floor(this.env.DEMO_MAX_UPLOAD_MB * 1024 * 1024);
    if (input.file.length > maxBytes) {
      this.count('file_too_large');
      throw new DemoError('file_too_large', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    await this.limit(`demo:up:h:${input.ipHash}`, this.env.DEMO_RL_PER_HOUR, HOUR_MS);
    await this.limit(`demo:up:d:${input.ipHash}`, this.env.DEMO_RL_PER_DAY, DAY_MS);

    if ((await this.budget.demoSnapshot()).exhausted) {
      this.count('budget_exhausted');
      throw new DemoError('budget_exhausted', HttpStatus.TOO_MANY_REQUESTS);
    }
    const captcha = await this.turnstile.verify(input.turnstileToken);
    if (captcha !== 'ok') {
      this.count(captcha === 'failed' ? 'captcha_failed' : 'captcha_unavailable');
      throw captcha === 'failed'
        ? new DemoError('captcha_failed', HttpStatus.FORBIDDEN)
        : new DemoError('captcha_unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    }

    let clean;
    try {
      clean = await sanitizeUpload(input.file);
    } catch (error) {
      if (error instanceof UnsupportedUploadError) {
        this.count('unsupported_file');
        throw new DemoError('unsupported_file', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
      }
      throw error;
    }

    const requestId = `demo-${randomUUID()}`;
    const key = `${DEMO_S3_PREFIX}${requestId}.${clean.extension}`;
    return inSpan(
      { name: 'demo.process', attributes: { channel: 'demo', request_id: requestId } },
      async () => {
        await this.storage.putStream({
          key,
          body: Readable.from(clean.bytes),
          contentType: clean.mime,
        });
        try {
          const mediaUrl = await this.storage.getPresignedUrl(key, PRESIGN_TTL_S);
          const mainState = (await this.budget.snapshot()).state;
          let response;
          try {
            response = await this.ai.processDemo({
              request_id: requestId,
              user: { language: input.language, age: null, sex: null },
              input: { type: 'image', media_url: mediaUrl, mime: clean.mime },
              context: {},
              options: { include_trace: true, want_spoken: false, budget_state: mainState },
            });
          } catch (error) {
            this.count('ai_error');
            this.logger.warn(
              {
                request_id: requestId,
                kind: error instanceof AiServiceError ? error.kind : 'error',
              },
              'demo AI call failed',
            );
            throw new DemoError('ai_unavailable', HttpStatus.BAD_GATEWAY);
          }
          await this.budget.recordDemo(response.meta.cost_usd);
          this.count('upload');
          this.logger.info(
            {
              request_id: requestId,
              intent: response.intent,
              latency_ms: response.meta.latency_ms,
            },
            'demo processed',
          );
          return {
            intent: response.intent,
            extraction: response.extraction ?? null,
            warnings: response.warnings,
            interactions: response.interactions ?? null,
            reply: response.reply,
            debug_trace: response.debug_trace ?? null,
            meta: response.meta,
            cached: false,
            uploads_enabled: await this.uploadsEnabled(),
          };
        } finally {
          // The 24 h lifecycle rule is the backstop; the file is not kept a minute longer than needed.
          await this.storage.deleteObject(key).catch((error: unknown) => {
            this.logger.warn({ error: (error as Error).name }, 'demo upload cleanup failed');
          });
        }
      },
    );
  }

  private async limit(key: string, limit: number, windowMs: number): Promise<void> {
    const result = await this.windows.hit(key, limit, windowMs);
    if (!result.allowed) {
      this.count('rate_limited');
      throw new DemoError(
        'rate_limited',
        HttpStatus.TOO_MANY_REQUESTS,
        Math.ceil(result.retryAfterMs / 1000),
      );
    }
  }

  private count(status: string): void {
    this.metrics.webRequests.inc({ channel: 'demo', status });
  }
}
