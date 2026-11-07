import { EnvValidationError, validateEnv } from './env.schema';

const valid = {
  NODE_ENV: 'test',
  SERVICE_TOKEN: 'test-service-token',
  AI_SERVICE_URL: 'http://localhost:8000',
  DATABASE_URL: 'postgresql://dawai:dawai@localhost:5432/dawai',
  REDIS_URL: 'redis://localhost:6379',
  S3_BUCKET: 'dawai-media',
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
    });
  });

  it('coerces PORT and MEDIA_RETENTION_DAYS from strings', () => {
    const env = validateEnv({ ...valid, PORT: '4100', MEDIA_RETENTION_DAYS: '7' });
    expect(env.PORT).toBe(4100);
    expect(env.MEDIA_RETENTION_DAYS).toBe(7);
  });

  it('ignores variables owned by later modules', () => {
    const env = validateEnv({ ...valid, WA_ACCESS_TOKEN: 'later-module' });
    expect(env).not.toHaveProperty('WA_ACCESS_TOKEN');
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
