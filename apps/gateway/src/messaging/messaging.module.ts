import { Module } from '@nestjs/common';

import { I18nService } from './i18n/i18n.service';
import { MediaService } from './media.service';
import { MessagesService } from './messages.service';
import { OutboundQueue } from './outbound.queue';
import { OutboundService } from './outbound.service';
import { OutboundWorker } from './outbound.worker';
import { StatusUpdater } from './status-updater.service';
import { TemplateRegistry } from './template.registry';
import { WhatsAppClient } from './whatsapp.client';

/**
 * WhatsApp messaging: inbound persistence (M2), the Graph API client, the `outbound` queue and
 * worker, media download, templates, i18n and delivery statuses (M3).
 */
@Module({
  providers: [
    MessagesService,
    WhatsAppClient,
    TemplateRegistry,
    I18nService,
    MediaService,
    OutboundQueue,
    OutboundService,
    OutboundWorker,
    StatusUpdater,
  ],
  exports: [
    MessagesService,
    WhatsAppClient,
    TemplateRegistry,
    I18nService,
    MediaService,
    OutboundService,
    OutboundQueue,
    StatusUpdater,
  ],
})
export class MessagingModule {}
