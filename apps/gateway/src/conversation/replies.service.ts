import { Injectable } from '@nestjs/common';

import type { EmergencyKind } from '../common/safety/emergency-keywords';
import { I18nService, type MessageKey } from '../messaging/i18n/i18n.service';
import { OutboundService } from '../messaging/outbound.service';
import type { UserLanguage } from '../users/users.service';

export interface ReplyContext {
  userId: string;
  language: UserLanguage;
  /** `messages.id` of the inbound message being answered: part of the idempotency key. */
  messageId: string;
  requestId: string;
  /** ISO time the user's message was received (M15: for `reply_latency_ms`). */
  receivedAt?: string;
}

export interface ButtonSpec {
  /** Stable id the router matches on (see BUTTON_ID). */
  id: string;
  /** i18n key of the visible title (max 20 characters in every language). */
  titleKey: MessageKey;
}

/** Emergency replies jump the outbound queue (BullMQ priority 1 = highest). */
export const EMERGENCY_PRIORITY = 1;

type Params = Readonly<Record<string, string | number>>;

/**
 * Replies to ONE inbound message. Each reply gets the next `replyIndex`, so the outbound job id
 * (`<messageId>_<index>`) is stable: if the inbound job is retried, the same replies map to the same
 * jobs and the user does not get them twice. Texts always come from i18n, never from the router.
 */
export class ReplySession {
  private nextIndex = 0;
  private intent: string | undefined;

  constructor(
    private readonly outbound: OutboundService,
    private readonly i18n: I18nService,
    private readonly ctx: ReplyContext,
    private language: UserLanguage = ctx.language,
  ) {}

  get currentLanguage(): UserLanguage {
    return this.language;
  }

  get requestId(): string {
    return this.ctx.requestId;
  }

  /** M15: the AI intent of this conversation turn; AI replies sent after this record their latency. */
  markIntent(intent: string): void {
    this.intent = intent;
  }

  private latency(): { latency: { receivedAt: string; intent: string } } | Record<string, never> {
    return this.ctx.receivedAt && this.intent
      ? { latency: { receivedAt: this.ctx.receivedAt, intent: this.intent } }
      : {};
  }

  /** `messages.id` of the inbound message being answered. */
  get messageId(): string {
    return this.ctx.messageId;
  }

  /** Switch the language used for the REST of this session (e.g. right after the user changed it). */
  useLanguage(language: UserLanguage): void {
    this.language = language;
  }

  /** A translated string in the session's language (for building a longer line). */
  translate(key: MessageKey, params: Params = {}): string {
    return this.i18n.t(this.language, key, params);
  }

  text(key: MessageKey, params: Params = {}): Promise<void> {
    return this.sendText(this.i18n.t(this.language, key, params));
  }

  /**
   * An i18n text at a FIXED reply index (it does not advance the counter). Used for the "something
   * went wrong" message so a retried job can never send it more than once per inbound message.
   */
  textAt(replyIndex: number, key: MessageKey, params: Params = {}): Promise<void> {
    return this.sendText(this.i18n.t(this.language, key, params), undefined, replyIndex);
  }

  /** A reply whose text comes from the AI service (already in the user's language). */
  rawText(body: string): Promise<void> {
    return this.sendText(body, undefined, undefined, this.latency());
  }

  /** M13: a spoken reply (the audio is already uploaded to WhatsApp; only its media id is queued). */
  rawAudio(mediaId: string): Promise<void> {
    return this.outbound.enqueue(this.ctx.userId, {
      content: { kind: 'audio', mediaId },
      sourceMessageId: this.ctx.messageId,
      replyIndex: this.nextIndex++,
      requestId: this.ctx.requestId,
    });
  }

  /** The AI service's emergency reply: plain text, highest outbound priority, never buttons. */
  rawEmergencyText(body: string): Promise<void> {
    return this.sendText(body, EMERGENCY_PRIORITY, undefined, this.latency());
  }

  /** A reply with buttons from the AI service (the contract limits them to 3, title <= 20). */
  rawButtons(body: string, buttons: readonly { id: string; title: string }[]): Promise<void> {
    return this.outbound.enqueue(this.ctx.userId, {
      content: { kind: 'buttons', body, buttons: buttons.map(({ id, title }) => ({ id, title })) },
      sourceMessageId: this.ctx.messageId,
      replyIndex: this.nextIndex++,
      requestId: this.ctx.requestId,
      ...this.latency(),
    });
  }

  /** Buttons from the AI service under a short translated prompt (when the answer itself was long). */
  rawButtonsWithPrompt(
    bodyKey: MessageKey,
    buttons: readonly { id: string; title: string }[],
  ): Promise<void> {
    return this.rawButtons(this.i18n.t(this.language, bodyKey), buttons);
  }

  buttons(bodyKey: MessageKey, params: Params, buttons: readonly ButtonSpec[]): Promise<void> {
    return this.outbound.enqueue(this.ctx.userId, {
      content: {
        kind: 'buttons',
        body: this.i18n.t(this.language, bodyKey, params),
        buttons: buttons.map((button) => ({
          id: button.id,
          title: this.i18n.t(this.language, button.titleKey),
        })),
      },
      sourceMessageId: this.ctx.messageId,
      replyIndex: this.nextIndex++,
      requestId: this.ctx.requestId,
    });
  }

  /**
   * The emergency message (112 / 108, plus Tele-MANAS 14416 for self-harm). Highest queue priority.
   * `bilingual` is for users who have not chosen a language yet: Hindi and English in one message.
   */
  emergency(kind: EmergencyKind, bilingual: boolean): Promise<void> {
    const key: MessageKey = kind === 'self_harm' ? 'emergency.self_harm' : 'emergency.general';
    const body = bilingual
      ? `${this.i18n.t('hi', key)}\n\n${this.i18n.t('en', key)}`
      : this.i18n.t(this.language, key);
    return this.sendText(body, EMERGENCY_PRIORITY);
  }

  /** Several i18n texts as ONE message (several separate jobs could be delivered out of order). */
  textParts(keys: readonly MessageKey[]): Promise<void> {
    return this.sendText(keys.map((key) => this.i18n.t(this.language, key)).join('\n\n'));
  }

  /** A header line followed by one line per item, as ONE message (e.g. the MEDS list). */
  textLines(
    headerKey: MessageKey,
    items: readonly { key: MessageKey; params: Params }[],
  ): Promise<void> {
    const lines = [
      this.i18n.t(this.language, headerKey),
      ...items.map((item) => this.i18n.t(this.language, item.key, item.params)),
    ];
    return this.sendText(lines.join('\n'));
  }

  private sendText(
    body: string,
    priority?: number,
    replyIndex?: number,
    extra: object = {},
  ): Promise<void> {
    return this.outbound.enqueue(this.ctx.userId, {
      content: { kind: 'text', body },
      sourceMessageId: this.ctx.messageId,
      replyIndex: replyIndex ?? this.nextIndex++,
      requestId: this.ctx.requestId,
      ...(priority !== undefined ? { priority } : {}),
      ...extra,
    });
  }
}

@Injectable()
export class RepliesService {
  constructor(
    private readonly outbound: OutboundService,
    private readonly i18n: I18nService,
  ) {}

  session(ctx: ReplyContext): ReplySession {
    return new ReplySession(this.outbound, this.i18n, ctx);
  }
}
