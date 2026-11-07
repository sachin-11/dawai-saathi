import { z } from 'zod';

const PLACEHOLDER_SECRETS = new Set(['change-me', 'changeme', '']);

/** `change-me`, empty, or one of the `local-dev-*` defaults from `.env.example`. */
const isPlaceholder = (value: string): boolean =>
  PLACEHOLDER_SECRETS.has(value) || value.startsWith('local-dev');

/**
 * The local-only AES key shipped in `.env.example` (base64 of a readable 32-byte string).
 * It is public, so it must never be accepted in production.
 */
export const DEV_ENCRYPTION_KEY = 'ZGF3YWktbG9jYWwtZGV2LWtleS1ub3Qtc2VjcmV0ISE=';

/** Empty string means "not set" (e.g. `S3_ENDPOINT=` on AWS). */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Environment contract for the gateway.
 *
 * M0: core. M1: database, Redis, S3. M2: WhatsApp webhook + crypto keys.
 * Later modules extend this schema (WhatsApp sending, ...) — see CLAUDE.md §9.
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

    // --- M1: data stores
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    S3_BUCKET: z.string().min(3, 'must be at least 3 characters'),
    /** Set for MinIO locally; leave empty on AWS. */
    S3_ENDPOINT: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
    AWS_REGION: z.string().min(1).default('ap-south-1'),
    /** Static keys are for local MinIO only; on AWS leave empty and use the task IAM role. */
    S3_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    S3_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    MEDIA_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

    // --- M2: WhatsApp webhook (inbound)
    /** Meta's `hub.verify_token` for the GET handshake. */
    WA_VERIFY_TOKEN: z.string().min(8, 'must be at least 8 characters'),
    /** App secret used to verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body). */
    WA_APP_SECRET: z.string().min(8, 'must be at least 8 characters'),
    /** Events for any other phone number id are ignored (200, logged). */
    WA_PHONE_NUMBER_ID: z.string().regex(/^\d+$/, 'must be the numeric phone number id'),

    // --- M2: PII protection (CLAUDE.md §2.6, §12)
    /** AES-256-GCM key: base64 of exactly 32 bytes. */
    ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must be base64 for exactly 32 bytes (e.g. `openssl rand -base64 32`)',
    }),
    /** Secret pepper mixed into the phone-number hash. Changing it orphans existing users. */
    PHONE_HASH_PEPPER: z.string().min(8, 'must be at least 8 characters'),

    /** Set `false` to run the HTTP side without consuming queues (tests, API-only replicas). */
    WORKERS_ENABLED: z.stringbool().default(true),

    // --- M3: outbound messaging + media
    /** WhatsApp Cloud API bearer token (temporary 24h token or a system-user token). */
    WA_ACCESS_TOKEN: z.string().min(8, 'must be at least 8 characters'),
    WA_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/, 'must look like v21.0')
      .default('v21.0'),
    /** Only override for tests/mocks. */
    WA_API_BASE_URL: z.url({ protocol: /^https?$/ }).default('https://graph.facebook.com'),
    /** Inbound media larger than this is not downloaded. */
    MAX_MEDIA_MB: z.coerce.number().int().min(1).max(100).default(10),
    /** Outbound throughput cap (BullMQ limiter). Meta's default per-number limit is 80/s. */
    OUTBOUND_RATE_PER_SEC: z.coerce.number().int().min(1).max(80).default(20),
    /** DEV ONLY: echo inbound messages back. Bypasses consent, refused when NODE_ENV=production. */
    DEV_ECHO_BOT: z.stringbool().default(false),
    /** Server-side encryption for stored media. `none` only for a local MinIO without a KMS key. */
    S3_SSE: z.enum(['AES256', 'none']).default('AES256'),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_SECRET_ACCESS_KEY'],
        message: 'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
      });
    }
    if (env.NODE_ENV === 'production' && env.DEV_ECHO_BOT) {
      // The echo bot answers anyone without consent (CLAUDE.md §2.7).
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_ECHO_BOT'],
        message: 'the dev echo bot must not be enabled in production',
      });
    }
    if (env.NODE_ENV === 'production') {
      const placeholders = {
        SERVICE_TOKEN: isPlaceholder(env.SERVICE_TOKEN),
        PHONE_HASH_PEPPER: isPlaceholder(env.PHONE_HASH_PEPPER),
        WA_VERIFY_TOKEN: isPlaceholder(env.WA_VERIFY_TOKEN),
        WA_APP_SECRET: isPlaceholder(env.WA_APP_SECRET),
        WA_ACCESS_TOKEN: isPlaceholder(env.WA_ACCESS_TOKEN),
        ENCRYPTION_KEY: env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY,
      };
      for (const [name, isDefault] of Object.entries(placeholders)) {
        if (isDefault) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'placeholder value is not allowed in production',
          });
        }
      }
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
