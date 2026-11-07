import type { PrismaService } from '../common/prisma/prisma.service';
import type { RedisService } from '../common/redis/redis.service';
import type { StorageService } from '../common/storage/storage.service';
import { READINESS_TIMEOUT_MS, ReadinessService } from './readiness.service';

type Check = jest.Mock<Promise<void>, []>;

const healthy = (): Check => jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
const failing = (message = 'down'): Check =>
  jest.fn<Promise<void>, []>().mockRejectedValue(new Error(message));
const hanging = (): Check =>
  jest.fn<Promise<void>, []>().mockReturnValue(new Promise(() => undefined));

function build(overrides: { db?: Check; redis?: Check; s3?: Check } = {}): {
  service: ReadinessService;
  db: Check;
  redis: Check;
  s3: Check;
} {
  const db = overrides.db ?? healthy();
  const redis = overrides.redis ?? healthy();
  const s3 = overrides.s3 ?? healthy();
  const service = new ReadinessService(
    { healthCheck: db } as unknown as PrismaService,
    { healthCheck: redis } as unknown as RedisService,
    { healthCheck: s3 } as unknown as StorageService,
  );
  return { service, db, redis, s3 };
}

describe('ReadinessService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is "ok" when every dependency answers', async () => {
    const { service, db, redis, s3 } = build();
    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      checks: { db: 'ok', redis: 'ok', s3: 'ok' },
    });
    expect(db).toHaveBeenCalledTimes(1);
    expect(redis).toHaveBeenCalledTimes(1);
    expect(s3).toHaveBeenCalledTimes(1);
  });

  it.each(['db', 'redis', 's3'] as const)(
    'is "degraded" and marks only %s as failed',
    async (name) => {
      const { service } = build({ [name]: failing() });
      const report = await service.check();
      expect(report.status).toBe('degraded');
      expect(report.checks).toEqual({ db: 'ok', redis: 'ok', s3: 'ok', [name]: 'fail' });
    },
  );

  it('reports every failure when several dependencies are down', async () => {
    const { service } = build({ db: failing(), redis: failing(), s3: failing() });
    await expect(service.check()).resolves.toEqual({
      status: 'degraded',
      checks: { db: 'fail', redis: 'fail', s3: 'fail' },
    });
  });

  it('fails a check that hangs instead of hanging the probe', async () => {
    jest.useFakeTimers();
    const { service } = build({ redis: hanging() });

    const pending = service.check();
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({
      status: 'degraded',
      checks: { db: 'ok', redis: 'fail', s3: 'ok' },
    });
  });

  it('never puts the underlying error message in the report', async () => {
    const secret = 'postgresql://dawai:s3cr3t@db:5432/dawai';
    const { service } = build({ db: failing(secret) });
    const report = await service.check();
    expect(JSON.stringify(report)).not.toContain('s3cr3t');
  });
});
