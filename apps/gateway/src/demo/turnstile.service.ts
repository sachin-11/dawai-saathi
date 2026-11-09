import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult = 'ok' | 'failed' | 'unavailable';

/**
 * Cloudflare Turnstile, verified server-side for UPLOADS only (bundled samples skip it).
 * No secret configured: allowed only in development/test (or with TURNSTILE_SKIP in test), so a
 * production deploy without keys has uploads switched off instead of open to bots (fail closed).
 */
@Injectable()
export class TurnstileService {
  constructor(
    @Inject(APP_CONFIG)
    private readonly env: Pick<Env, 'NODE_ENV' | 'TURNSTILE_SECRET_KEY' | 'TURNSTILE_SKIP'>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TurnstileService.name);
  }

  async verify(token: string | undefined): Promise<TurnstileResult> {
    if (this.env.TURNSTILE_SKIP && this.env.NODE_ENV !== 'production') return 'ok';
    const secret = this.env.TURNSTILE_SECRET_KEY;
    if (!secret) return this.env.NODE_ENV === 'production' ? 'unavailable' : 'ok';
    if (!token || token.length > 2048) return 'failed';
    try {
      const body = new URLSearchParams({ secret, response: token });
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return 'unavailable';
      const json = (await response.json()) as { success?: unknown };
      return json.success === true ? 'ok' : 'failed';
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'turnstile verification unavailable');
      return 'unavailable';
    }
  }
}
