import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module';
import { ReminderQueueModule } from '../reminders/reminder.queue';
import { CaregiverInboundService } from './caregiver-inbound.service';
import { CaregiversService } from './caregivers.service';

/** Family contacts (F5): invite, verify, alert, remove. */
@Module({
  imports: [MessagingModule, ReminderQueueModule],
  providers: [CaregiversService, CaregiverInboundService],
  exports: [CaregiversService, CaregiverInboundService],
})
export class CaregiversModule {}
