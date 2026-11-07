import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { APP_CONFIG } from '../../config/config.constants';
import type { Env } from '../../config/env.schema';
import { resolveRequestId } from './request-id';

/**
 * Structured JSON logs (pino). Every log line emitted while handling a request
 * carries `request_id`. Sensitive headers are redacted; request/response
 * serializers keep only method, url and status — never bodies (PHI, CLAUDE.md §10).
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          base: { service: 'gateway' },
          genReqId: resolveRequestId,
          customAttributeKeys: { reqId: 'request_id' },
          quietReqLogger: true,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-service-token"]',
              'req.headers["x-hub-signature-256"]',
            ],
            censor: '[REDACTED]',
          },
          serializers: {
            req: (req: { method?: string; url?: string }) => ({
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggerModule {}
