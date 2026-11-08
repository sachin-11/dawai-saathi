import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CaregiverInboundService } from '../caregivers/caregiver-inbound.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PendingStore } from '../common/pending/pending.store';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { MessagesService } from '../messaging/messages.service';
import { StatusUpdater } from '../messaging/status-updater.service';
import type { InboundJobData } from '../queues/queue.constants';
import { InboundQueue } from '../queues/inbound.queue';
import { parseCaregiverAddNumber } from '../conversation/commands';
import { classifyInbound, type MessageSignals } from '../conversation/signals';
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
    private readonly statuses: StatusUpdater,
    private readonly caregivers: CaregiverInboundService,
    private readonly pending: PendingStore,
    private readonly crypto: CryptoService,
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

    // Statuses describe OUR outbound messages: update delivery state, never create user messages.
    for (const status of parsed.statuses) {
      await this.statuses.apply(status);
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
    // M10: a caregiver's YES / NO / STOP ALERTS is recognised by their number BEFORE onboarding: a
    // caregiver is not automatically a user. The answer goes to the `reminders` queue; nothing of it is
    // stored as a user message. Anything else from that number continues as a normal message.
    if (await this.caregivers.tryHandle(message)) {
      return false;
    }

    const user = await this.users.findOrCreateByPhone(message.from);
    await this.users.touchLastInbound(user.id, message.timestamp);
    // Data minimisation (§2.7): before the user has consented we keep metadata only, no text.
    const saved = await this.messages.saveInbound(user.id, message, {
      storeBody: user.onboardingStep === 'done',
    });
    const signals = classifyInbound(message);
    if (user.onboardingStep === 'done') {
      await this.captureText(user.id, message, signals);
    }

    // Enqueue even for a duplicate: the jobId makes it a no-op if the job exists, and it repairs the
    // case "row saved, enqueue failed, Meta retried" which would otherwise lose the message.
    const job: InboundJobData = {
      messageId: saved.id,
      userId: saved.userId,
      waMessageId: message.waMessageId,
      type: message.type,
      ...(message.media ? { media: message.media } : {}),
      ...(message.button ? { button: message.button } : {}),
      ...(Object.keys(signals).length > 0 ? { signals } : {}),
      receivedAt: message.timestamp.toISOString(),
      requestId,
    };
    await this.queue.add(job);
    return saved.duplicate;
  }

  /**
   * Text that the queue must not carry but a flow needs (CLAUDE.md §2.6): kept ENCRYPTED in Redis for
   * a few minutes and read once by the router.
   *  - `CAREGIVER +91...` -> the number
   *  - the next text while a question is open ("which times?", "what do they call you?") -> the answer
   */
  private async captureText(
    userId: string,
    message: InboundMessage,
    signals: MessageSignals,
  ): Promise<void> {
    if (message.type !== 'text' || message.text === undefined) return;
    if (signals.command === 'caregiver_add') {
      const number = parseCaregiverAddNumber(message.text);
      if (number) {
        await this.pending.setValue('cg_phone', userId, this.crypto.encrypt(number), 600);
      } else {
        await this.pending.clear('cg_phone', userId);
      }
      return;
    }
    if (signals.emergency || signals.command || signals.ack) return;
    if (await this.pending.exists('input', userId)) {
      await this.pending.setValue('input_text', userId, this.crypto.encrypt(message.text), 300);
      signals.input = true;
    }
  }
}
