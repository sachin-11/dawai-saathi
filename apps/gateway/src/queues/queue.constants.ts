import type { MessageSignals } from '../conversation/signals';
import type { InboundButton, InboundMedia, InboundMessageType } from '../webhook/inbound-message';

export const INBOUND_QUEUE = 'inbound';

/**
 * Payload of an `inbound` job. Deliberately small and PII-free (CLAUDE.md §2.6): NO phone number and
 * NO message text. The worker looks up what it needs by `messageId` / `userId` in the database.
 */
export interface InboundJobData {
  /** `messages.id` */
  messageId: string;
  /** `users.id` */
  userId: string;
  waMessageId: string;
  type: InboundMessageType;
  /** Media is not downloaded until M3, so the Meta media id travels here. */
  media?: InboundMedia;
  button?: InboundButton;
  /**
   * What the router needs to know about the message text, as small enums (emergency / command).
   * Computed in the webhook, where the text is already in memory, so no text enters the queue.
   */
  signals?: MessageSignals;
  /** ISO timestamp of when the message was sent (from Meta). */
  receivedAt: string;
  /** Request id of the webhook call, for log correlation. */
  requestId: string;
}
