import { Global, Module } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service';
import { BudgetService } from './budget.service';
import { CostReportService } from './cost-report.service';
import { WINDOW_STORE } from './limits.constants';
import { RateLimitService } from './rate-limit.service';
import { RedisWindowStore } from './sliding-window';

/** Rate limits, abuse blocking and the daily LLM budget (M15). */
@Global()
@Module({
  providers: [
    {
      provide: WINDOW_STORE,
      inject: [RedisService],
      useFactory: (redis: RedisService) => new RedisWindowStore(redis),
    },
    RateLimitService,
    BudgetService,
    CostReportService,
  ],
  exports: [WINDOW_STORE, RateLimitService, BudgetService],
})
export class LimitsModule {}
