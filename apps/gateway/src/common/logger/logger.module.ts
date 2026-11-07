import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Writable } from 'node:stream';

import { APP_CONFIG } from '../../config/config.constants';
import type { Env } from '../../config/env.schema';
import { LOG_STREAM, LogStreamModule } from './log-stream';
import { resolveRequestId } from './request-id';

/**
 * Structured JSON logs (pino). Every log line emitted while handling a request
 * carries `request_id`. Sensitive headers are redacted; request/response
 * serializers keep only method, url and status — never bodies (PHI, CLAUDE.md §10).
 */
@Module({
  imports: [
    LogStreamModule,
    PinoLoggerModule.forRootAsync({
      inject: [APP_CONFIG, LOG_STREAM],
      useFactory: (env: Env, stream: Writable | undefined) => {
        const options = {
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
        };
        return { pinoHttp: stream ? ([options, stream] as [typeof options, Writable]) : options };
      },
    }),
  ],
})
export class LoggerModule {}
