import { Module } from '@nestjs/common';

import { AiClientModule } from '../ai-client/ai-client.module';
import { CaregiversModule } from '../caregivers/caregivers.module';
import { DeletionModule } from '../deletion/deletion.module';
import { DevModule } from '../dev/dev.module';
import { DocumentsModule } from '../documents/documents.module';
import { MessagingModule } from '../messaging/messaging.module';
import { RemindersModule } from '../reminders/reminders.module';
import { UsersModule } from '../users/users.module';
import { AiProcessor } from './ai-processor.service';
import { CaregiverFlowService } from './caregiver-flow.service';
import { CommandHandlersService } from './command-handlers.service';
import { DeletionFlowService } from './deletion-flow.service';
import { InboundRouter } from './inbound-router';
import { OnboardingService } from './onboarding.service';
import { PendingInputService } from './pending-input.service';
import { ReminderFlowService } from './reminder-flow.service';
import { RepliesService } from './replies.service';
import { RxActionsService } from './rx-actions.service';

/** Conversation logic: routing, onboarding + consent, commands and the DELETE flow (M4). */
@Module({
  imports: [
    MessagingModule,
    UsersModule,
    DeletionModule,
    DevModule,
    AiClientModule,
    DocumentsModule,
    RemindersModule,
    CaregiversModule,
  ],
  providers: [
    InboundRouter,
    AiProcessor,
    OnboardingService,
    CommandHandlersService,
    DeletionFlowService,
    RepliesService,
    RxActionsService,
    ReminderFlowService,
    CaregiverFlowService,
    PendingInputService,
  ],
  exports: [InboundRouter],
})
export class ConversationModule {}
