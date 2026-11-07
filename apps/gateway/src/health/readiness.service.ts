import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { StorageService } from '../common/storage/storage.service';
import { withTimeout } from '../common/timeout/with-timeout';

export const READINESS_TIMEOUT_MS = 2000;

export type CheckStatus = 'ok' | 'fail';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: { db: CheckStatus; redis: CheckStatus; s3: CheckStatus };
}

/**
 * Readiness = "can this instance do useful work right now?" (unlike liveness, which only says the
 * process is up). Checks run in parallel, each with its own 2 s budget, so a hung dependency can
 * never make the probe hang. Failures are logged by error type only — never the message, which may
 * contain connection strings.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [db, redis, s3] = await Promise.all([
      this.run('db', () => this.prisma.healthCheck()),
      this.run('redis', () => this.redis.healthCheck()),
      this.run('s3', (signal) => this.storage.healthCheck(signal)),
    ]);
    const checks = { db, redis, s3 };
    const healthy = Object.values(checks).every((result) => result === 'ok');
    return { status: healthy ? 'ok' : 'degraded', checks };
  }

  private async run(
    name: string,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<CheckStatus> {
    try {
      await withTimeout(work, READINESS_TIMEOUT_MS);
      return 'ok';
    } catch (error) {
      this.logger.warn(
        `readiness check "${name}" failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return 'fail';
    }
  }
}
