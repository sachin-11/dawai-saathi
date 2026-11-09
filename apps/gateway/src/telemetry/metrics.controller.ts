import { timingSafeEqual } from 'node:crypto';

import { Controller, Get, Header, Headers, Inject, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { MetricsService } from './metrics.service';

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GET /metrics: Prometheus exposition. Never public: needs METRICS_TOKEN (required in production). */
@Controller('metrics')
@SkipThrottle()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly env: Pick<Env, 'METRICS_TOKEN'>,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Headers('authorization') authorization?: string): Promise<string> {
    const expected = this.env.METRICS_TOKEN;
    if (expected !== undefined) {
      const provided = (authorization ?? '').replace(/^Bearer /, '');
      if (!tokensMatch(provided, expected)) throw new UnauthorizedException();
    }
    return this.metrics.render();
  }
}
