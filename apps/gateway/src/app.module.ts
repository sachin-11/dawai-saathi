import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from './audit/audit.service';
import { CryptoModule } from './common/crypto/crypto.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggerModule } from './common/logger/logger.module';
import { PendingModule } from './common/pending/pending.store';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { StorageModule } from './common/storage/storage.module';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { QueuesModule } from './queues/queues.module';
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
    // Opt-in per controller (see WebhookController); in-memory counters, per instance.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    QueuesModule,
    HealthModule,
    WebhookModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
