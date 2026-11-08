import { Module } from '@nestjs/common';

import { CaregiversModule } from '../caregivers/caregivers.module';
import { MessagingModule } from '../messaging/messaging.module';
import { QueuesModule } from '../queues/queues.module';
import { UsersModule } from '../users/users.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard';

@Module({
  imports: [UsersModule, MessagingModule, QueuesModule, CaregiversModule],
  controllers: [WebhookController],
  providers: [WebhookService, WhatsAppSignatureGuard],
})
export class WebhookModule {}
