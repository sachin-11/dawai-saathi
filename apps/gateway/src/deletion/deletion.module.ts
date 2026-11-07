import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module';
import { QueueCleanupService } from './queue-cleanup.service';
import { UserDeletionQueue } from './user-deletion.queue';
import { UserDeletionService } from './user-deletion.service';
import { UserDeletionWorker } from './user-deletion.worker';

@Module({
  imports: [MessagingModule],
  providers: [UserDeletionQueue, QueueCleanupService, UserDeletionService, UserDeletionWorker],
  exports: [UserDeletionQueue],
})
export class DeletionModule {}
