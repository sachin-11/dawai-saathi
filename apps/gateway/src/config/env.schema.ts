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

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    // --- M5: AI service client
    /** The AI service can take up to PROCESS_TIMEOUT_S (60 s); keep this a little higher. */
    AI_CLIENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(70_000),

    // --- M13: voice notes
    /**
     * Spoken replies (text-to-speech). Off by default; a user also needs VOICE ON. The AI service
     * reads the same variable (it only builds a TTS provider when it is true). The maximum voice-note
     * length (MAX_AUDIO_SECONDS) is enforced by the AI service, which measures the audio.
     */
    TTS_ENABLED: z.stringbool().default(false),

    // --- M4: consent text
    /** Link shown in the consent message. The real privacy-policy page arrives with M16 (web app). */
    PRIVACY_POLICY_URL: z
      .url({ protocol: /^https?$/ })
      .default('https://dawaisaathi.example/privacy'),
    // --- M7: prescriptions
    /**
     * Endpoint used ONLY to presign media URLs for the AI service, when the AI service reaches S3
     * under another hostname than the gateway (e.g. `http://minio:9000` from a container). Empty:
     * the same endpoint as `S3_ENDPOINT`. The AI service must have the host in ALLOWED_MEDIA_HOSTS.
     */
    S3_AI_ENDPOINT: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
    /** Clock times (Asia/Kolkata) a written "morning / afternoon / evening / night" is saved as. */
    MED_TIME_MORNING: z.string().regex(CLOCK_TIME, 'must be HH:MM').default('08:00'),
    MED_TIME_AFTERNOON: z.string().regex(CLOCK_TIME, 'must be HH:MM').default('14:00'),
    MED_TIME_EVENING: z.string().regex(CLOCK_TIME, 'must be HH:MM').default('18:00'),
    MED_TIME_NIGHT: z.string().regex(CLOCK_TIME, 'must be HH:MM').default('21:00'),
    // --- M10: reminders + caregivers
    /** A slot is a delayed job; the planner (every 15 min) materialises this many hours ahead. */
    REMINDER_HORIZON_HOURS: z.coerce.number().int().min(2).max(168).default(36),
    /** Prescriptions without a written duration get reminders for this many days, then a renewal ask. */
    REMINDER_OPEN_ENDED_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    SNOOZE_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
    /** Minutes after a sent reminder without an answer before the dose counts as missed. */
    REMINDER_ACK_TIMEOUT_MIN: z.coerce.number().int().min(5).max(600).default(60),
    /** This many missed slots in a row trigger the caregiver alert. */
    CAREGIVER_ALERT_AFTER_MISSES: z.coerce.number().int().min(1).max(20).default(2),
    DAILY_SUMMARY_ENABLED: z.stringbool().default(false),
    /**
     * DEV ONLY: when set, `rem:test` shifts every slot to "now + N minutes" for manual testing.
     * Refused when NODE_ENV=production.
     */
    REMINDER_TEST_OFFSET_MIN: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(60).optional(),
    ),
    // --- M15: observability, rate limits, cost guard
    /** OTLP/HTTP collector base URL (e.g. http://otel-collector:4318). Empty: tracing is off. */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
      emptyToUndefined,
      z.url({ protocol: /^https?$/ }).optional(),
    ),
    /** Share of ordinary traces that are kept. Errors and emergencies are always kept. */
    OTEL_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.2),
    /** `Authorization: Bearer <token>` for GET /metrics. Required in production. */
    METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
    /** Workers stop taking jobs on SIGTERM and get this long to finish the ones in flight. */
    SHUTDOWN_GRACE_S: z.coerce.number().int().min(1).max(600).default(25),
    /**
     * Requests per minute per IP on the webhook route (abuse guard, runs before the signature check).
     * Meta calls from few IPs and a load balancer hides them all behind one, so this must be far above the
     * real traffic: the k6 smoke test (20 msg/s) was throttled to 25% by the old fixed 300/min.
     */
    WEBHOOK_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(1_000_000).default(6000),
    RL_MSG_PER_MIN: z.coerce.number().int().min(1).max(1000).default(10),
    RL_MSG_PER_DAY: z.coerce.number().int().min(1).max(100000).default(200),
    RL_DOCS_PER_DAY: z.coerce.number().int().min(1).max(10000).default(20),
    RL_VOICE_PER_DAY: z.coerce.number().int().min(1).max(10000).default(30),
    RL_CAREGIVER_INVITES_PER_DAY: z.coerce.number().int().min(1).max(100).default(3),
    /** More than this many limited windows in one local day blocks the user for RL_BLOCK_HOURS. */
    RL_BLOCK_AFTER_WINDOWS: z.coerce.number().int().min(1).max(1000).default(5),
    RL_BLOCK_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    /** Daily LLM budget in USD (Asia/Kolkata day). Unset: the guard is off (always `normal`). */
    LLM_DAILY_BUDGET_USD: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
    USER_DAILY_COST_USD: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
    BUDGET_ECONOMY_PCT: z.coerce.number().min(1).max(100).default(70),
    BUDGET_ESSENTIAL_PCT: z.coerce.number().min(1).max(100).default(90),
    // --- M16: web demo + admin API (both are OFF unless their secret is set)
    /** `X-Demo-Key` that only the Next.js server knows. Unset: `/demo/*` answers 404. */
    DEMO_API_KEY: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
    /** Token the AI service accepts ONLY on /v1/process and which lets the demo ask for `debug_trace`. */
    DEMO_SERVICE_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
    /** Own daily LLM budget of the demo (Asia/Kolkata day). Over it: uploads off, samples from cache. */
    DEMO_DAILY_BUDGET_USD: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
    DEMO_RL_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(10),
    DEMO_RL_PER_DAY: z.coerce.number().int().min(1).max(10000).default(30),
    DEMO_MAX_UPLOAD_MB: z.coerce.number().min(0.1).max(10).default(5),
    /** Cloudflare Turnstile secret. Unset: demo uploads are refused outside development/test. */
    TURNSTILE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    /** Test-only: skip the Turnstile call (never in production). */
    TURNSTILE_SKIP: z.stringbool().default(false),
    /** Comma separated e-mail allowlist of operators. Unset: `/admin/*` answers 404. */
    ADMIN_EMAILS: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .transform((value) =>
          value
            .split(',')
            .map((item) => item.trim().toLowerCase())
            .filter((item) => item.length > 0),
        )
        .optional(),
    ),
    /** HS256 secret that signs the 5-minute admin JWT (shared with the Next.js server only). */
    ADMIN_JWT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    /** Where `sync:admin-data` put the eval reports and prompt list (default: ./admin-data next to dist). */
    ADMIN_DATA_DIR: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
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
    if (env.NODE_ENV === 'production' && env.REMINDER_TEST_OFFSET_MIN !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['REMINDER_TEST_OFFSET_MIN'],
        message: 'the reminder test offset must not be set in production',
      });
    }
    if (env.DEMO_API_KEY !== undefined && env.DEMO_API_KEY === env.SERVICE_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEMO_API_KEY'],
        message: 'must differ from SERVICE_TOKEN',
      });
    }
    if (env.DEMO_SERVICE_TOKEN !== undefined && env.DEMO_SERVICE_TOKEN === env.SERVICE_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEMO_SERVICE_TOKEN'],
        message: 'must differ from SERVICE_TOKEN',
      });
    }
    if (env.DEMO_API_KEY !== undefined && env.DEMO_SERVICE_TOKEN === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEMO_SERVICE_TOKEN'],
        message: 'required when DEMO_API_KEY is set (the demo needs its own AI token)',
      });
    }
    if (env.NODE_ENV === 'production' && env.TURNSTILE_SKIP) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SKIP'],
        message: 'must not be set in production',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      env.DEMO_API_KEY !== undefined &&
      env.DEMO_DAILY_BUDGET_USD === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEMO_DAILY_BUDGET_USD'],
        message: 'required in production when the demo is enabled',
      });
    }
    if (env.BUDGET_ECONOMY_PCT >= env.BUDGET_ESSENTIAL_PCT) {
      ctx.addIssue({
        code: 'custom',
        path: ['BUDGET_ESSENTIAL_PCT'],
        message: 'must be greater than BUDGET_ECONOMY_PCT',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (env.METRICS_TOKEN === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['METRICS_TOKEN'],
          message: 'required in production (/metrics must never be public)',
        });
      }
      if (env.LLM_DAILY_BUDGET_USD === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['LLM_DAILY_BUDGET_USD'],
          message: 'required in production (the daily cost guard)',
        });
      }
    }
    if (env.NODE_ENV === 'production') {
      // M17: everything a user or Meta can reach must be HTTPS, and the example link must be replaced.
      if (env.S3_ENDPOINT !== undefined && !env.S3_ENDPOINT.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_ENDPOINT'],
          message: 'must be https in production (leave it empty on AWS)',
        });
      }
      if (
        !env.PRIVACY_POLICY_URL.startsWith('https://') ||
        env.PRIVACY_POLICY_URL.includes('.example')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['PRIVACY_POLICY_URL'],
          message: 'must be the real https privacy page in production',
        });
      }
    }
    if (env.NODE_ENV === 'production') {
      const placeholders = {
        SERVICE_TOKEN: isPlaceholder(env.SERVICE_TOKEN),
        PHONE_HASH_PEPPER: isPlaceholder(env.PHONE_HASH_PEPPER),
        WA_VERIFY_TOKEN: isPlaceholder(env.WA_VERIFY_TOKEN),
        WA_APP_SECRET: isPlaceholder(env.WA_APP_SECRET),
        WA_ACCESS_TOKEN: isPlaceholder(env.WA_ACCESS_TOKEN),
        METRICS_TOKEN: env.METRICS_TOKEN !== undefined && isPlaceholder(env.METRICS_TOKEN),
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
