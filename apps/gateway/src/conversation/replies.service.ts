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

  /** Switch the language used for the REST of this session (e.g. right after the user changed it). */
  useLanguage(language: UserLanguage): void {
    this.language = language;
  }

  text(key: MessageKey, params: Params = {}): Promise<void> {
    return this.sendText(this.i18n.t(this.language, key, params));
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

  private sendText(body: string, priority?: number): Promise<void> {
    return this.outbound.enqueue(this.ctx.userId, {
      content: { kind: 'text', body },
      sourceMessageId: this.ctx.messageId,
      replyIndex: this.nextIndex++,
      requestId: this.ctx.requestId,
      ...(priority !== undefined ? { priority } : {}),
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
