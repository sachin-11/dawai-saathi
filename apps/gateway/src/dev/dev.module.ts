import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module';
import { EchoBotService } from './echo-bot.service';

/** Development-only helpers. Nothing here may be relied on in production. */
@Module({
  imports: [MessagingModule],
  providers: [EchoBotService],
  exports: [EchoBotService],
})
export class DevModule {}
