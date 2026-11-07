import { Module } from '@nestjs/common';

import { InboundQueue } from './inbound.queue';
import { InboundWorker } from './inbound.worker';

@Module({
  providers: [InboundQueue, InboundWorker],
  exports: [InboundQueue],
})
export class QueuesModule {}
