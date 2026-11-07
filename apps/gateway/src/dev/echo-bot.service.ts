import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { I18nService } from '../messaging/i18n/i18n.service';
import { MediaService } from '../messaging/media.service';
import { MessagesService } from '../messaging/messages.service';
import { OutboundService } from '../messaging/outbound.service';
import { WhatsAppClient } from '../messaging/whatsapp.client';
import type { InboundJobData } from '../queues/queue.constants';

/**
 * DEV ONLY echo bot: proves the whole loop (webhook -> queue -> worker -> outbound) with a real
 * Meta test number. Enabled with DEV_ECHO_BOT=true; the env schema refuses that in production.
 *
 * Since M4 the InboundRouter calls it only for users who finished onboarding (language + consent),
 * after the emergency check and the commands, so it can no longer be used to bypass consent
 * (CLAUDE.md §2.7). It only ever sees the REDACTED text stored in `messages.body_redacted`.
 * It is still a dev tool: keep DEV_ECHO_BOT=false outside local debugging (production refuses it).
 */
@Injectable()
export class EchoBotService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly client: WhatsAppClient,
    private readonly messages: MessagesService,
    private readonly media: MediaService,
    private readonly outbound: OutboundService,
    private readonly i18n: I18nService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EchoBotService.name);
  }

  onModuleInit(): void {
    if (this.env.DEV_ECHO_BOT) {
      this.logger.warn(
        'DEV ECHO BOT IS ENABLED: replies go out without consent. Never use in production.',
      );
    }
  }

  get enabled(): boolean {
    return this.env.DEV_ECHO_BOT;
  }

  async handle(job: InboundJobData): Promise<void> {
    const message = await this.messages.findInboundForReply(job.messageId);
    if (!message) {
      return; // the user was deleted meanwhile
    }
    const options = job.requestId ? { requestId: job.requestId } : {};
    const { language } = message;

    // Blue ticks right away; harmless if the job is retried.
    await this.client.markAsRead(job.waMessageId, options);

    const reply = async (text: string): Promise<void> => {
      await this.outbound.enqueue(job.userId, {
        content: { kind: 'text', body: text },
        sourceMessageId: job.messageId,
        replyIndex: 0,
        requestId: job.requestId,
      });
    };

    switch (job.type) {
      case 'text':
        await reply(this.i18n.t(language, 'dev.echo_text', { text: message.bodyRedacted ?? '' }));
        return;
      case 'image':
      case 'document':
      case 'audio': {
        if (!job.media) {
          await reply(this.i18n.t(language, 'common.unsupported_type'));
          return;
        }
        const result = await this.media.storeInboundMedia({
          messageId: job.messageId,
          userId: job.userId,
          mediaId: job.media.id,
          requestId: job.requestId,
        });
        if (result.status === 'stored') {
          await reply(
            this.i18n.t(language, 'dev.echo_media', {
              type: job.type,
              size_kb: Math.max(1, Math.round(result.bytes / 1024)),
            }),
          );
        } else if (result.reason === 'too_large') {
          await reply(
            this.i18n.t(language, 'common.file_too_large', { max_mb: this.env.MAX_MEDIA_MB }),
          );
        } else {
          await reply(this.i18n.t(language, 'common.unsupported_type'));
        }
        return;
      }
      case 'button':
        await reply(this.i18n.t(language, 'dev.echo_text', { text: job.button?.id ?? '' }));
        return;
      case 'unsupported':
        await reply(this.i18n.t(language, 'common.unsupported_type'));
        return;
    }
  }
}
