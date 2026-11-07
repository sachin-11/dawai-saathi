import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { APP_CONFIG } from '../../config/config.constants';
import type { Env } from '../../config/env.schema';

/**
 * The only door to PostgreSQL for the gateway (the gateway owns all user state, CLAUDE.md §4).
 *
 * The client connects lazily on the first query, so the app (and unit/e2e tests) can boot without a
 * database; `/health/ready` is what reports DB problems.
 *
 * Logging: Prisma's default log output can echo query details, and parameters can contain PHI
 * (§2.6, §10). So errors/warnings are routed to our structured logger as events and ONLY the
 * target is logged, never the message.
 */
@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'warn' | 'error'>
  implements OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) env: Env) {
    super({
      datasourceUrl: env.DATABASE_URL,
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    this.$on('warn', (event) => {
      this.logger.warn(`prisma warning (target: ${event.target})`);
    });
    this.$on('error', (event) => {
      this.logger.error(`prisma error (target: ${event.target})`);
    });
  }

  /** Cheap round-trip used by readiness. Throws if the DB is unreachable. */
  async healthCheck(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  /** Graceful shutdown (Nest calls this because main.ts enables shutdown hooks). */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch {
      // Disconnecting a client that never managed to connect can throw; nothing left to clean up.
    }
  }
}
