import { Module } from '@nestjs/common';

import { CaregiversModule } from '../caregivers/caregivers.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ReminderAckService } from './reminder-ack.service';
import { ReminderDispatchService } from './reminder-dispatch.service';
import { ReminderMessages } from './reminder-messages';
import { ReminderPlannerService } from './reminder-planner.service';
import { ReminderScheduleService } from './reminder-schedule.service';
import { ReminderQueueModule } from './reminder.queue';
import { ReminderWorker } from './reminder.worker';

/** Dose reminders (F4): schedules, the rolling-window planner, sending, acknowledgements, missed doses. */
@Module({
  imports: [MessagingModule, ReminderQueueModule, CaregiversModule],
  providers: [
    ReminderMessages,
    ReminderPlannerService,
    ReminderScheduleService,
    ReminderDispatchService,
    ReminderAckService,
    ReminderWorker,
  ],
  exports: [
    ReminderScheduleService,
    ReminderAckService,
    ReminderQueueModule,
    ReminderPlannerService,
  ],
})
export class RemindersModule {}
