import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the REAL stack with fake providers: the FastAPI AI service (LLM_MODE=fake), the NestJS
 * gateway and the production build of this app, on the docker test stack (`make test-infra-up`).
 * Ports are not the dev ports, so a running `make dev` is never disturbed.
 *
 * Needs: `pnpm --filter @dawai/gateway build` and `pnpm --filter @dawai/web build` first (CI does).
 */
const WEB = Number(process.env.E2E_WEB_PORT ?? 3011);
const GATEWAY = Number(process.env.E2E_GATEWAY_PORT ?? 3012);
const AI = Number(process.env.E2E_AI_PORT ?? 8766);

export const E2E = {
  web: `http://localhost:${WEB}`,
  gateway: `http://localhost:${GATEWAY}`,
  demoKey: 'e2e-demo-key-0123456789abcdef',
  adminEmail: 'admin@example.com',
  waNumber: '919999999999',
};

// Same variable names as the gateway integration tests; defaults are the local docker test stack.
const base = new URL(
  process.env.INTEGRATION_DATABASE_URL ?? 'postgresql://dawai:dawai@localhost:5543/dawai_test',
);
const e2eDb = new URL(base.toString());
e2eDb.pathname = '/dawai_e2e_test';
const aiDbUrl = new URL(e2eDb.toString());
aiDbUrl.username = 'dawai_ai_ro';
aiDbUrl.password = 'dawai_ai_ro';
const aiDb = aiDbUrl.toString();
const redisUrl = process.env.INTEGRATION_REDIS_URL ?? 'redis://localhost:6479';
const s3Endpoint = process.env.INTEGRATION_S3_ENDPOINT ?? 'http://localhost:9100';
const s3Bucket = process.env.INTEGRATION_S3_BUCKET ?? 'dawai-media-test';
const s3Key = process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? 'dawai-minio';
const s3Secret = process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? 'dawai-minio-secret';
const python = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: E2E.web, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: [
    {
      command: `${python} -m uvicorn app.main:create_app --factory --port ${AI}`,
      cwd: '../ai-service',
      url: `http://localhost:${AI}/health/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        LLM_MODE: 'fake',
        SERVICE_TOKEN: 'e2e-service-token',
        DEMO_SERVICE_TOKEN: 'e2e-demo-ai-token-0123456789',
        DATABASE_URL: aiDb,
        AI_DATABASE_URL: aiDb,
        ALLOWED_MEDIA_HOSTS: new URL(s3Endpoint).host,
      },
    },
    {
      command: 'node dist/main.js',
      cwd: '../gateway',
      url: `http://localhost:${GATEWAY}/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        PORT: String(GATEWAY),
        SERVICE_TOKEN: 'e2e-service-token',
        AI_SERVICE_URL: `http://localhost:${AI}`,
        DATABASE_URL: e2eDb.toString(),
        REDIS_URL: redisUrl,
        S3_BUCKET: s3Bucket,
        S3_ENDPOINT: s3Endpoint,
        S3_ACCESS_KEY_ID: s3Key,
        S3_SECRET_ACCESS_KEY: s3Secret,
        WA_VERIFY_TOKEN: 'verify-token-1234',
        WA_APP_SECRET: 'app-secret-1234',
        WA_PHONE_NUMBER_ID: '100000000000001',
        ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        PHONE_HASH_PEPPER: 'e2e-pepper-value',
        WA_ACCESS_TOKEN: 'access-token-1234',
        WORKERS_ENABLED: 'false',
        S3_SSE: 'AES256',
        DEMO_API_KEY: E2E.demoKey,
        DEMO_SERVICE_TOKEN: 'e2e-demo-ai-token-0123456789',
        DEMO_DAILY_BUDGET_USD: '5',
        DEMO_RL_PER_HOUR: '500',
        DEMO_RL_PER_DAY: '5000',
        TURNSTILE_SKIP: 'true',
        ADMIN_EMAILS: E2E.adminEmail,
        ADMIN_JWT_SECRET: 'e2e-admin-jwt-secret-0123456789abcdef',
      },
    },
    {
      command: `npx next start -p ${WEB}`,
      url: `http://localhost:${WEB}/robots.txt`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        GATEWAY_URL: `http://localhost:${GATEWAY}`,
        DEMO_API_KEY: E2E.demoKey,
        ADMIN_EMAILS: E2E.adminEmail,
        ADMIN_JWT_SECRET: 'e2e-admin-jwt-secret-0123456789abcdef',
        NEXTAUTH_SECRET: 'e2e-nextauth-secret-0123456789abcdef0123',
        NEXTAUTH_URL: `http://localhost:${WEB}`,
        ADMIN_TEST_LOGIN: 'true',
        NEXT_PUBLIC_WA_NUMBER: E2E.waNumber,
        NEXT_PUBLIC_SITE_URL: `http://localhost:${WEB}`,
      },
    },
  ],
});
