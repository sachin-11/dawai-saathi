import { EnvValidationError, validateEnv } from './env.schema';

const valid = {
  NODE_ENV: 'test',
  SERVICE_TOKEN: 'test-service-token',
  AI_SERVICE_URL: 'http://localhost:8000',
};

describe('validateEnv', () => {
  it('parses a valid env and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env).toEqual({ ...valid, LOG_LEVEL: 'info', PORT: 3000 });
  });

  it('coerces PORT from string', () => {
    expect(validateEnv({ ...valid, PORT: '4100' }).PORT).toBe(4100);
  });

  it('ignores variables owned by later modules', () => {
    const env = validateEnv({ ...valid, DATABASE_URL: 'postgresql://x' });
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it.each([
    ['SERVICE_TOKEN', { ...valid, SERVICE_TOKEN: undefined }],
    ['AI_SERVICE_URL', { ...valid, AI_SERVICE_URL: 'not-a-url' }],
    ['AI_SERVICE_URL', { ...valid, AI_SERVICE_URL: 'ftp://host' }],
    ['NODE_ENV', { ...valid, NODE_ENV: 'staging' }],
    ['PORT', { ...valid, PORT: '70000' }],
    ['LOG_LEVEL', { ...valid, LOG_LEVEL: 'verbose' }],
  ])('rejects invalid %s', (key, raw) => {
    expect(() => validateEnv(raw)).toThrow(new RegExp(key));
  });

  it('reports every problem at once', () => {
    try {
      validateEnv({});
      fail('expected validateEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects placeholder SERVICE_TOKEN in production', () => {
    expect(() =>
      validateEnv({ ...valid, NODE_ENV: 'production', SERVICE_TOKEN: 'change-me' }),
    ).toThrow(/SERVICE_TOKEN: placeholder/);
  });

  it('never echoes secret values in the error message', () => {
    const secret = 'short';
    try {
      validateEnv({ ...valid, SERVICE_TOKEN: secret });
      fail('expected validateEnv to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
