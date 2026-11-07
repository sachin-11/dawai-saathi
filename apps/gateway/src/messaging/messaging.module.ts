import { Module } from '@nestjs/common';

import { MessagesService } from './messages.service';

/** WhatsApp messaging. M2: persistence of inbound messages. M3 adds the outbound client. */
@Module({
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagingModule {}
