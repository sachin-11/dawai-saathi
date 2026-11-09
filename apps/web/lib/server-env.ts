import { z } from 'zod';

/**
 * Server-only configuration (route handlers, server components, auth). Never import this from a
 * client component: `tests/security.test.ts` fails when a client file imports it, and when any
 * server-only variable carries a NEXT_PUBLIC_ prefix.
 */
const schema = z.object({
  GATEWAY_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  DEMO_API_KEY: z.string().min(16).optional(),
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ADMIN_JWT_SECRET: z.string().min(32).optional(),
  AUTH_GITHUB_ID: z.string().optional(),
  AUTH_GITHUB_SECRET: z.string().optional(),
  ADMIN_TEST_LOGIN: z.enum(['true', 'false']).default('false'),
  GRAFANA_URL: z.string().optional(),
  LANGFUSE_URL: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (!cached) {
    const emptyToUndefined = Object.fromEntries(
      Object.entries(process.env).map(([key, value]) => [key, value === '' ? undefined : value]),
    );
    cached = schema.parse(emptyToUndefined);
    if (cached.NODE_ENV === 'production' && cached.ADMIN_TEST_LOGIN === 'true') {
      throw new Error('ADMIN_TEST_LOGIN must not be enabled in production');
    }
  }
  return cached;
}

/** For tests. */
export function resetServerEnvForTests(): void {
  cached = undefined;
}
