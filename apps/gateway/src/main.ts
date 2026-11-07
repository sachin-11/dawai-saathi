import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { EnvValidationError, validateEnv } from './config/env.schema';
import { loadDotEnv } from './config/load-dotenv';

async function bootstrap(): Promise<void> {
  loadDotEnv();
  // Validate before Nest boots so misconfiguration produces one clear message.
  const env = validateEnv(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
  logger.log(`gateway listening on :${env.PORT}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  const message =
    error instanceof EnvValidationError
      ? error.message
      : `Fatal bootstrap error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
