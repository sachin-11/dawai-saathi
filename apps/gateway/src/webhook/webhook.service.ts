import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { MessagesService } from '../messaging/messages.service';
import type { InboundJobData } from '../queues/queue.constants';
import { InboundQueue } from '../queues/inbound.queue';
import { UsersService } from '../users/users.service';
import type { InboundMessage } from './inbound-message';
import { parseWebhook } from './whatsapp.parser';

export interface WebhookSummary {
  messages: number;
  statuses: number;
  duplicates: number;
  foreign: number;
  invalid: number;
}

@Injectable()
export class WebhookService {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly users: UsersService,
    private readonly messages: MessagesService,
    private readonly queue: InboundQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookService.name);
  }

  /**
   * Handle one (already signature-verified) webhook body:
   * parse -> for each message: user -> save -> enqueue. Throws if the DB or Redis fails, so the
   * controller answers 500 and Meta redelivers; redelivery is safe because every step is idempotent.
   */
  async handle(body: unknown, requestId: string): Promise<WebhookSummary> {
    const parsed = parseWebhook(body, this.env.WA_PHONE_NUMBER_ID);

    // Statuses describe OUR outbound messages. Log only; persisting them comes in M3.
    for (const status of parsed.statuses) {
      this.logger.info(
        {
          wa_message_id: status.waMessageId,
          status: status.status,
          ...(status.errorCode !== undefined ? { error_code: status.errorCode } : {}),
        },
        'whatsapp status update',
      );
    }
    if (parsed.foreignCount > 0) {
      this.logger.info(
        { count: parsed.foreignCount },
        'ignored events for a different phone number id',
      );
    }
    if (parsed.invalidCount > 0) {
      this.logger.warn({ count: parsed.invalidCount }, 'skipped malformed webhook items');
    }

    // Sequential on purpose: keeps per-user message order and bounds DB/Redis load.
    let duplicates = 0;
    for (const message of parsed.messages) {
      if (await this.processMessage(message, requestId)) {
        duplicates += 1;
      }
    }

    return {
      messages: parsed.messages.length,
      statuses: parsed.statuses.length,
      duplicates,
      foreign: parsed.foreignCount,
      invalid: parsed.invalidCount,
    };
  }

  /** Returns true if the message had already been stored (redelivery). */
  private async processMessage(message: InboundMessage, requestId: string): Promise<boolean> {
    const user = await this.users.findOrCreateByPhone(message.from);
    await this.users.touchLastInbound(user.id, message.timestamp);
    const saved = await this.messages.saveInbound(user.id, message);

    // Enqueue even for a duplicate: the jobId makes it a no-op if the job exists, and it repairs the
    // case "row saved, enqueue failed, Meta retried" which would otherwise lose the message.
    const job: InboundJobData = {
      messageId: saved.id,
      userId: saved.userId,
      waMessageId: message.waMessageId,
      type: message.type,
      ...(message.media ? { media: message.media } : {}),
      ...(message.button ? { button: message.button } : {}),
      receivedAt: message.timestamp.toISOString(),
      requestId,
    };
    await this.queue.add(job);
    return saved.duplicate;
  }
}
