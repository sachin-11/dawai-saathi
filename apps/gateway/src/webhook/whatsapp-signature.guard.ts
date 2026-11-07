import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  type RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { SIGNATURE_HEADER, verifySignature } from './whatsapp-signature';

/**
 * Rejects (401) any POST whose `X-Hub-Signature-256` is missing or does not match the HMAC of the
 * raw body. Requires the app to be created with `rawBody: true` (see app.setup.ts).
 * Logs only a fixed message: the request id is attached by the logger, never the body or headers.
 */
@Injectable()
export class WhatsAppSignatureGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WhatsAppSignatureGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const header = request.headers[SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;

    if (!verifySignature(request.rawBody, signature, this.env.WA_APP_SECRET)) {
      this.logger.warn('rejected webhook call: missing or invalid signature');
      throw new UnauthorizedException('Invalid signature');
    }
    return true;
  }
}
