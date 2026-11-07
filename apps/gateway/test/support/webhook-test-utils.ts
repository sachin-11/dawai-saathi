import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, configureApp } from '../../src/app.setup';
import { signBody } from '../../src/webhook/whatsapp-signature';

export const WA_APP_SECRET = 'test-app-secret';
export const WA_VERIFY_TOKEN = 'test-verify-token';
export const WA_PHONE_NUMBER_ID = '100000000000001';

/** Env that makes the app boot without any real infrastructure (nothing listens on port 1). */
export const OFFLINE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERVICE_TOKEN: 'test-service-token',
  AI_SERVICE_URL: 'http://localhost:8000',
  DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/none',
  REDIS_URL: 'redis://127.0.0.1:1',
  S3_BUCKET: 'test-bucket',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  WA_VERIFY_TOKEN,
  WA_APP_SECRET,
  WA_PHONE_NUMBER_ID,
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  PHONE_HASH_PEPPER: 'test-pepper-value',
  WORKERS_ENABLED: 'false',
};

export function fixtureBuffer(name: string): Buffer {
  return readFileSync(join(__dirname, '..', 'fixtures', 'whatsapp', `${name}.json`));
}

/** Headers for a correctly signed JSON POST of exactly these bytes. */
export function signedHeaders(raw: Buffer | string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': signBody(raw, WA_APP_SECRET),
  };
}

export async function createApp(
  customise: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<INestApplication> {
  const moduleRef = await customise(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
  configureApp(app as unknown as NestExpressApplication);
  await app.init();
  return app;
}
