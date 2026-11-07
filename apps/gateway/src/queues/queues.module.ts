import { Module } from '@nestjs/common';

import { DevModule } from '../dev/dev.module';
import { InboundQueue } from './inbound.queue';
import { InboundWorker } from './inbound.worker';

@Module({
  imports: [DevModule],
  providers: [InboundQueue, InboundWorker],
  exports: [InboundQueue],
})
export class QueuesModule {}
