import { z } from 'zod';

const PLACEHOLDER_SECRETS = new Set(['change-me', 'changeme', '']);

/**
 * Environment contract for the gateway.
 *
 * M0 validates only what the skeleton needs. Later modules extend this schema
 * (WhatsApp, database, Redis, S3, crypto keys) — see CLAUDE.md §9.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    SERVICE_TOKEN: z.string().min(8, 'must be at least 8 characters'),
    AI_SERVICE_URL: z.url({ protocol: /^https?$/ }),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && PLACEHOLDER_SECRETS.has(env.SERVICE_TOKEN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SERVICE_TOKEN'],
        message: 'placeholder value is not allowed in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse and validate env. Throws EnvValidationError listing every problem.
 * Error messages name the variable but never echo its value (secrets!).
 */
export function validateEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.map(String).join('.') || '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }
  return result.data;
}
