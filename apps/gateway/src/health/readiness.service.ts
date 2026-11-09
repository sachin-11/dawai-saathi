import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { StorageService } from '../common/storage/storage.service';
import { withTimeout } from '../common/timeout/with-timeout';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { QueueMetricsCollector } from '../telemetry/queue-metrics.collector';

export const READINESS_TIMEOUT_MS = 2000;

export type CheckStatus = 'ok' | 'fail';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  /** Gating checks: any failure makes the instance not ready (503). `queues` is added by the app. */
  checks: { db: CheckStatus; redis: CheckStatus; s3: CheckStatus; queues?: CheckStatus };
  /**
   * M15: informational, never gating. The AI service being down must not take the webhook out of the
   * load balancer: messages wait in the queue and are answered when it is back.
   */
  info?: { ai: CheckStatus };
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
    @Optional() private readonly queues?: QueueMetricsCollector,
    @Optional() @Inject(APP_CONFIG) private readonly env?: Pick<Env, 'AI_SERVICE_URL'>,
  ) {}

  async check(): Promise<ReadinessReport> {
    const queues = this.queues;
    const aiUrl = this.env?.AI_SERVICE_URL;
    const [db, redis, s3, queuesResult, ai] = await Promise.all([
      this.run('db', () => this.prisma.healthCheck()),
      this.run('redis', () => this.redis.healthCheck()),
      this.run('s3', (signal) => this.storage.healthCheck(signal)),
      queues ? this.run('queues', () => queues.ping()) : Promise.resolve(undefined),
      aiUrl
        ? this.run('ai', async (signal) => {
            const response = await fetch(`${aiUrl.replace(/\/+$/, '')}/health/live`, { signal });
            if (!response.ok) throw new Error('ai not live');
          })
        : Promise.resolve(undefined),
    ]);
    const checks = { db, redis, s3, ...(queuesResult ? { queues: queuesResult } : {}) };
    const healthy = Object.values(checks).every((result) => result === 'ok');
    return {
      status: healthy ? 'ok' : 'degraded',
      checks,
      ...(ai ? { info: { ai } } : {}),
    };
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
