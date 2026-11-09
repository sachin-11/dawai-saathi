import { Module } from '@nestjs/common';

import { ConversationModule } from '../conversation/conversation.module';
import { UsersModule } from '../users/users.module';
import { DlqEffects } from './dlq-effects.service';
import { InboundQueue } from './inbound.queue';
import { InboundWorker } from './inbound.worker';

@Module({
  imports: [ConversationModule, UsersModule],
  providers: [InboundQueue, InboundWorker, DlqEffects],
  exports: [InboundQueue],
})
export class QueuesModule {}
