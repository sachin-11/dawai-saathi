import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import { WA_APP_SECRET, WA_PHONE_NUMBER_ID, WA_VERIFY_TOKEN } from './webhook-test-utils';

/**
 * Connection settings for integration tests (docker-compose.test.yml, or CI services).
 * Same INTEGRATION_* variable names as infra.int-spec.ts.
 */
export const INTEGRATION_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  SERVICE_TOKEN: 'integration-test-token',
  AI_SERVICE_URL: 'http://localhost:8000',
  DATABASE_URL:
    process.env['INTEGRATION_DATABASE_URL'] ?? 'postgresql://dawai:dawai@localhost:5543/dawai_test',
  REDIS_URL: process.env['INTEGRATION_REDIS_URL'] ?? 'redis://localhost:6479',
  S3_BUCKET: process.env['INTEGRATION_S3_BUCKET'] ?? 'dawai-media-test',
  S3_ENDPOINT: process.env['INTEGRATION_S3_ENDPOINT'] ?? 'http://localhost:9100',
  S3_ACCESS_KEY_ID: process.env['INTEGRATION_S3_ACCESS_KEY_ID'] ?? 'dawai-minio',
  S3_SECRET_ACCESS_KEY: process.env['INTEGRATION_S3_SECRET_ACCESS_KEY'] ?? 'dawai-minio-secret',
  WA_VERIFY_TOKEN,
  WA_APP_SECRET,
  WA_PHONE_NUMBER_ID,
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  PHONE_HASH_PEPPER: 'integration-pepper-value',
  WORKERS_ENABLED: 'false',
  WA_ACCESS_TOKEN: 'integration-access-token',
  DEV_ECHO_BOT: 'false',
  S3_SSE: 'AES256',
};

/** Refuse to touch anything but a `*_test` database, then apply the real migrations. */
export function prepareTestDatabase(databaseUrl: string): void {
  const dbName = new URL(databaseUrl).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against database "${dbName}" (must end with _test)`,
    );
  }
  const prismaCli = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
