import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggerModule } from './common/logger/logger.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { StorageModule } from './common/storage/storage.module';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [AppConfigModule, LoggerModule, PrismaModule, RedisModule, StorageModule, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
