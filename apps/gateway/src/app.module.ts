import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.service';
import { CryptoModule } from './common/crypto/crypto.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggerModule } from './common/logger/logger.module';
import { PendingModule } from './common/pending/pending.store';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { StorageModule } from './common/storage/storage.module';
import { AppConfigModule } from './config/config.module';
import { APP_CONFIG } from './config/config.constants';
import type { Env } from './config/env.schema';
import { DemoModule } from './demo/demo.module';
import { HealthModule } from './health/health.module';
import { LimitsModule } from './limits/limits.module';
import { QueuesModule } from './queues/queues.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    PrismaModule,
    RedisModule,
    StorageModule,
    CryptoModule,
    PendingModule,
    AuditModule,
    TelemetryModule,
    LimitsModule,
    // Opt-in per controller (see WebhookController); in-memory counters, per instance.
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => [{ ttl: 60_000, limit: env.WEBHOOK_RATE_LIMIT_PER_MIN }],
    }),
    QueuesModule,
    HealthModule,
    WebhookModule,
    DemoModule,
    AdminModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
