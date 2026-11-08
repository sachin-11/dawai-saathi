import { DEV_ENCRYPTION_KEY, EnvValidationError, validateEnv } from './env.schema';

const valid = {
  NODE_ENV: 'test',
  SERVICE_TOKEN: 'test-service-token',
  AI_SERVICE_URL: 'http://localhost:8000',
  DATABASE_URL: 'postgresql://dawai:dawai@localhost:5432/dawai',
  REDIS_URL: 'redis://localhost:6379',
  S3_BUCKET: 'dawai-media',
  WA_VERIFY_TOKEN: 'verify-token-123',
  WA_APP_SECRET: 'app-secret-123',
  WA_PHONE_NUMBER_ID: '100000000000001',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PHONE_HASH_PEPPER: 'pepper-123456',
  WA_ACCESS_TOKEN: 'access-token-123',
};

describe('validateEnv', () => {
  it('parses a valid env and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env).toEqual({
      ...valid,
      LOG_LEVEL: 'info',
      PORT: 3000,
      AWS_REGION: 'ap-south-1',
      MEDIA_RETENTION_DAYS: 30,
      WORKERS_ENABLED: true,
      WA_API_VERSION: 'v21.0',
      WA_API_BASE_URL: 'https://graph.facebook.com',
      MAX_MEDIA_MB: 10,
      OUTBOUND_RATE_PER_SEC: 20,
      DEV_ECHO_BOT: false,
      MED_TIME_MORNING: '08:00',
      MED_TIME_AFTERNOON: '14:00',
      MED_TIME_EVENING: '18:00',
      MED_TIME_NIGHT: '21:00',
      PRIVACY_POLICY_URL: 'https://dawaisaathi.example/privacy',
      AI_CLIENT_TIMEOUT_MS: 70000,
      S3_SSE: 'AES256',
      REMINDER_HORIZON_HOURS: 36,
      REMINDER_OPEN_ENDED_DAYS: 30,
      SNOOZE_MINUTES: 30,
      REMINDER_ACK_TIMEOUT_MIN: 60,
      CAREGIVER_ALERT_AFTER_MISSES: 2,
      DAILY_SUMMARY_ENABLED: false,
    });
  });

  it('coerces PORT and MEDIA_RETENTION_DAYS from strings', () => {
    const env = validateEnv({ ...valid, PORT: '4100', MEDIA_RETENTION_DAYS: '7' });
    expect(env.PORT).toBe(4100);
    expect(env.MEDIA_RETENTION_DAYS).toBe(7);
  });

  it('ignores variables owned by later modules', () => {
    const env = validateEnv({ ...valid, WA_BUSINESS_ACCOUNT_ID: 'later-module' });
    expect(env).not.toHaveProperty('WA_BUSINESS_ACCOUNT_ID');
  });

  describe('S3 settings', () => {
    it('treats empty S3_ENDPOINT and keys as unset (AWS mode)', () => {
      const env = validateEnv({
        ...valid,
        S3_ENDPOINT: '',
        S3_ACCESS_KEY_ID: '',
        S3_SECRET_ACCESS_KEY: '',
      });
      expect(env.S3_ENDPOINT).toBeUndefined();
      expect(env.S3_ACCESS_KEY_ID).toBeUndefined();
      expect(env.S3_SECRET_ACCESS_KEY).toBeUndefined();
    });

    it('accepts a MinIO endpoint with static keys (local mode)', () => {
      const env = validateEnv({
        ...valid,
        S3_ENDPOINT: 'http://localhost:9000',
        S3_ACCESS_KEY_ID: 'minio',
        S3_SECRET_ACCESS_KEY: 'minio-secret',
      });
      expect(env.S3_ENDPOINT).toBe('http://localhost:9000');
    });

    it('requires access key and secret together', () => {
      expect(() => validateEnv({ ...valid, S3_ACCESS_KEY_ID: 'only-the-id' })).toThrow(
        /S3_SECRET_ACCESS_KEY: .*together/,
      );
    });
  });

  it.each([
    ['SERVICE_TOKEN', { ...valid, SERVICE_TOKEN: undefined }],
    ['AI_SERVICE_URL', { ...valid, AI_SERVICE_URL: 'not-a-url' }],
    ['AI_SERVICE_URL', { ...valid, AI_SERVICE_URL: 'ftp://host' }],
    ['NODE_ENV', { ...valid, NODE_ENV: 'staging' }],
    ['PORT', { ...valid, PORT: '70000' }],
    ['LOG_LEVEL', { ...valid, LOG_LEVEL: 'verbose' }],
    ['DATABASE_URL', { ...valid, DATABASE_URL: undefined }],
    ['DATABASE_URL', { ...valid, DATABASE_URL: 'mysql://u:p@localhost/db' }],
    ['REDIS_URL', { ...valid, REDIS_URL: undefined }],
    ['REDIS_URL', { ...valid, REDIS_URL: 'http://localhost:6379' }],
    ['S3_BUCKET', { ...valid, S3_BUCKET: undefined }],
    ['S3_ENDPOINT', { ...valid, S3_ENDPOINT: 'not-a-url' }],
    ['MEDIA_RETENTION_DAYS', { ...valid, MEDIA_RETENTION_DAYS: '0' }],
    ['WA_VERIFY_TOKEN', { ...valid, WA_VERIFY_TOKEN: undefined }],
    ['WA_APP_SECRET', { ...valid, WA_APP_SECRET: undefined }],
    ['WA_PHONE_NUMBER_ID', { ...valid, WA_PHONE_NUMBER_ID: 'not-a-number' }],
    ['ENCRYPTION_KEY', { ...valid, ENCRYPTION_KEY: undefined }],
    ['ENCRYPTION_KEY', { ...valid, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }],
    ['PHONE_HASH_PEPPER', { ...valid, PHONE_HASH_PEPPER: 'short' }],
    ['WA_ACCESS_TOKEN', { ...valid, WA_ACCESS_TOKEN: undefined }],
    ['WA_API_VERSION', { ...valid, WA_API_VERSION: '21' }],
    ['WA_API_BASE_URL', { ...valid, WA_API_BASE_URL: 'not-a-url' }],
    ['MAX_MEDIA_MB', { ...valid, MAX_MEDIA_MB: '0' }],
    ['OUTBOUND_RATE_PER_SEC', { ...valid, OUTBOUND_RATE_PER_SEC: '500' }],
    ['S3_SSE', { ...valid, S3_SSE: 'aes' }],
  ])('rejects invalid %s', (key, raw) => {
    expect(() => validateEnv(raw)).toThrow(new RegExp(key));
  });

  it('reports every problem at once', () => {
    try {
      validateEnv({});
      fail('expected validateEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.length).toBeGreaterThanOrEqual(6);
    }
  });

  describe('M3 settings', () => {
    it('REMINDER_TEST_OFFSET_MIN is a dev helper and is refused in production', () => {
      expect(
        validateEnv({ ...valid, REMINDER_TEST_OFFSET_MIN: '3' }).REMINDER_TEST_OFFSET_MIN,
      ).toBe(3);
      expect(
        validateEnv({ ...valid, REMINDER_TEST_OFFSET_MIN: '' }).REMINDER_TEST_OFFSET_MIN,
      ).toBeUndefined();
      expect(() =>
        validateEnv({
          ...valid,
          NODE_ENV: 'production',
          REMINDER_TEST_OFFSET_MIN: '3',
          SERVICE_TOKEN: 'a-real-production-token-123456',
          PHONE_HASH_PEPPER: 'a-real-pepper-value',
          WA_VERIFY_TOKEN: 'a-real-verify-token',
          WA_APP_SECRET: 'a-real-app-secret-value',
          WA_ACCESS_TOKEN: 'a-real-access-token-value',
          ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        }),
      ).toThrow(/REMINDER_TEST_OFFSET_MIN/);
    });

    it('DEV_ECHO_BOT is off by default and can be turned on outside production', () => {
      expect(validateEnv(valid).DEV_ECHO_BOT).toBe(false);
      expect(validateEnv({ ...valid, DEV_ECHO_BOT: 'true' }).DEV_ECHO_BOT).toBe(true);
    });

    it('REFUSES the dev echo bot in production (it bypasses consent)', () => {
      expect(() =>
        validateEnv({
          ...valid,
          NODE_ENV: 'production',
          SERVICE_TOKEN: 'a-real-service-token',
          DEV_ECHO_BOT: 'true',
        }),
      ).toThrow(/DEV_ECHO_BOT: the dev echo bot must not be enabled in production/);
    });

    it('rejects the placeholder WA_ACCESS_TOKEN in production', () => {
      expect(() =>
        validateEnv({
          ...valid,
          NODE_ENV: 'production',
          SERVICE_TOKEN: 'a-real-service-token',
          WA_ACCESS_TOKEN: 'local-dev-access-token',
        }),
      ).toThrow(/WA_ACCESS_TOKEN: placeholder/);
    });

    it.each(['WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'PHONE_HASH_PEPPER'])(
      'rejects the local-dev default of %s in production',
      (key) => {
        expect(() =>
          validateEnv({
            ...valid,
            NODE_ENV: 'production',
            SERVICE_TOKEN: 'a-real-service-token',
            [key]: 'local-dev-something',
          }),
        ).toThrow(new RegExp(`${key}: placeholder`));
      },
    );

    it('accepts S3_SSE=none (local MinIO without KMS) and a custom API base URL', () => {
      const env = validateEnv({
        ...valid,
        S3_SSE: 'none',
        WA_API_BASE_URL: 'http://localhost:9999',
      });
      expect(env.S3_SSE).toBe('none');
      expect(env.WA_API_BASE_URL).toBe('http://localhost:9999');
    });
  });

  describe('M2 settings', () => {
    it('parses WORKERS_ENABLED=false', () => {
      expect(validateEnv({ ...valid, WORKERS_ENABLED: 'false' }).WORKERS_ENABLED).toBe(false);
    });

    it.each([
      ['PHONE_HASH_PEPPER', 'change-me'],
      ['WA_VERIFY_TOKEN', 'change-me'],
      ['WA_APP_SECRET', 'change-me'],
      ['ENCRYPTION_KEY', DEV_ENCRYPTION_KEY],
    ])('rejects the placeholder %s in production', (key, value) => {
      expect(() =>
        validateEnv({
          ...valid,
          NODE_ENV: 'production',
          SERVICE_TOKEN: 'a-real-service-token',
          [key]: value,
        }),
      ).toThrow(new RegExp(`${key}: placeholder`));
    });

    it('accepts the same values outside production', () => {
      expect(() =>
        validateEnv({ ...valid, SERVICE_TOKEN: 'change-me', ENCRYPTION_KEY: DEV_ENCRYPTION_KEY }),
      ).not.toThrow();
    });
  });

  it('rejects placeholder SERVICE_TOKEN in production', () => {
    expect(() =>
      validateEnv({ ...valid, NODE_ENV: 'production', SERVICE_TOKEN: 'change-me' }),
    ).toThrow(/SERVICE_TOKEN: placeholder/);
  });

  it('never echoes secret values in the error message', () => {
    const secret = 'short';
    const password = 'hunter2-db-password';
    try {
      validateEnv({
        ...valid,
        SERVICE_TOKEN: secret,
        DATABASE_URL: `mysql://dawai:${password}@localhost/db`,
      });
      fail('expected validateEnv to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain(password);
    }
  });
});
