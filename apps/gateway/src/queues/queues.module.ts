import { Module } from '@nestjs/common';

import { ConversationModule } from '../conversation/conversation.module';
import { InboundQueue } from './inbound.queue';
import { InboundWorker } from './inbound.worker';

@Module({
  imports: [ConversationModule],
  providers: [InboundQueue, InboundWorker],
  exports: [InboundQueue],
})
export class QueuesModule {}
