import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Optional,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { safeEqual } from '../common/crypto/safe-equal';
import { getRequestId } from '../common/logger/request-id';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { MetricsService } from '../telemetry/metrics.service';
import { WebhookService } from './webhook.service';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard';

/** Meta expects a fast answer: warn if we get anywhere near its timeout. */
export const SLOW_WEBHOOK_MS = 800;

@Controller('webhook/whatsapp')
// Per-IP limit: WEBHOOK_RATE_LIMIT_PER_MIN (M15 raised the default from 300 to 6000: see the env schema).
@UseGuards(ThrottlerGuard)
export class WebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly webhook: WebhookService,
    private readonly logger: PinoLogger,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.logger.setContext(WebhookController.name);
  }

  /** Meta's one-time subscription handshake. Echo `hub.challenge` only if the verify token matches. */
  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  verify(
    @Query('hub.mode') mode: unknown,
    @Query('hub.verify_token') token: unknown,
    @Query('hub.challenge') challenge: unknown,
  ): string {
    if (
      mode === 'subscribe' &&
      typeof token === 'string' &&
      typeof challenge === 'string' &&
      safeEqual(token, this.env.WA_VERIFY_TOKEN)
    ) {
      return challenge;
    }
    this.logger.warn('rejected webhook verification: wrong mode or verify token');
    throw new ForbiddenException('Verification failed');
  }

  /**
   * Incoming events. Always 200 for a correctly signed body (even unsupported types / foreign
   * numbers), otherwise Meta keeps retrying. A DB/Redis failure throws -> 500 -> Meta retries.
   */
  @Post()
  @HttpCode(200)
  @UseGuards(WhatsAppSignatureGuard)
  async receive(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'received' }> {
    const startedAt = performance.now();
    const requestId = getRequestId(res);
    let status = '2xx';
    try {
      const summary = await this.webhook.handle(body, requestId);
      this.logger.info(summary, 'webhook processed');
    } catch (error) {
      status = '5xx';
      // Log the error type only: messages from drivers can contain connection details.
      this.logger.error(
        { error: error instanceof Error ? error.name : 'unknown' },
        'webhook processing failed; responding 500 so Meta retries',
      );
      throw error;
    } finally {
      const elapsedMs = Math.round(performance.now() - startedAt);
      this.metrics?.webhookLatency.observe(elapsedMs);
      this.metrics?.webhookResponses.inc({ status });
      if (elapsedMs > SLOW_WEBHOOK_MS) {
        this.logger.warn({ elapsed_ms: elapsedMs }, 'slow webhook handler (Meta times out at ~5s)');
      }
    }
    return { status: 'received' };
  }
}
