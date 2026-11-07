import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Options every entry point (main.ts, e2e and integration tests) must use.
 * `rawBody: true` keeps the exact request bytes on `req.rawBody`; the WhatsApp signature is an HMAC
 * of those bytes and cannot be verified from re-serialised JSON.
 */
export const NEST_APP_OPTIONS: NestApplicationOptions = { rawBody: true, bufferLogs: true };

/** JSON body limit. Meta webhooks are small; this also caps abuse of the public endpoint. */
export const JSON_BODY_LIMIT = '1mb';

/** App-level setup shared by main.ts and tests. */
export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.enableShutdownHooks();
}
