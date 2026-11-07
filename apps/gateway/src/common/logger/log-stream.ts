import { Global, Module } from '@nestjs/common';
import type { Writable } from 'node:stream';

/** Optional destination for pino. `undefined` (default) = stdout. Tests override it to capture logs. */
export const LOG_STREAM = Symbol('LOG_STREAM');

@Global()
@Module({
  providers: [{ provide: LOG_STREAM, useValue: undefined as Writable | undefined }],
  exports: [LOG_STREAM],
})
export class LogStreamModule {}
