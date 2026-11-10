import { Module } from '@nestjs/common';

import { AiClientModule } from '../ai-client/ai-client.module';
import { DemoCacheService } from './demo-cache.service';
import { DemoKeyGuard } from './demo-key.guard';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';
import { TurnstileService } from './turnstile.service';

/** M16: the public web demo API. Nothing here touches users, messages, documents or medications. */
@Module({
  imports: [AiClientModule],
  controllers: [DemoController],
  providers: [DemoService, DemoCacheService, TurnstileService, DemoKeyGuard],
})
export class DemoModule {}
