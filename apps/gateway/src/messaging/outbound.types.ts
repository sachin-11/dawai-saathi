import type { TemplateLanguage, TemplateName } from './template.registry';
import type { ReplyButton } from './whatsapp.client';

export interface TextContent {
  kind: 'text';
  body: string;
  previewUrl?: boolean;
}

export interface ButtonsContent {
  kind: 'buttons';
  body: string;
  buttons: ReplyButton[];
}

export interface TemplateContent {
  kind: 'template';
  template: TemplateName;
  language: TemplateLanguage;
  params?: Record<string, string>;
  buttonPayloads?: string[];
}

/** M13: a spoken reply. Only the WhatsApp media id travels in the job (the audio is already uploaded). */
export interface AudioContent {
  kind: 'audio';
  mediaId: string;
}

export type OutboundContent = TextContent | ButtonsContent | TemplateContent | AudioContent;

export interface OutboundRequest {
  content: OutboundContent;
  /**
   * Sent instead of `content` when the 24 h window is closed (free-form messages are not allowed
   * then). Without it, a closed window is an error (WindowClosedError).
   */
  templateFallback?: TemplateContent;
  /** Id (usually `messages.id` of the inbound message) this reply answers. Part of the idempotency key. */
  sourceMessageId: string;
  /** Position of this reply among the replies to `sourceMessageId`. Part of the idempotency key. */
  replyIndex: number;
  requestId?: string;
  /**
   * Send to a caregiver instead of the user (M10). Caregivers are not users: their phone is read from
   * `caregivers`, their own 24 h window is `caregivers.last_inbound_at`, and the message is NOT stored
   * in the user's `messages` (it is not part of the user's conversation).
   */
  recipient?: { caregiverId: string };
  /** BullMQ priority (1 = highest). Emergency replies use 1 so they never wait behind other sends. */
  priority?: number;
}

/**
 * Payload of an `outbound` job. The message content is health information, so it is stored
 * ENCRYPTED (AES-256-GCM, same key as phone numbers): Redis never holds readable PHI.
 */
export interface OutboundJobData {
  userId: string;
  /** Encrypted JSON of `{ content, templateFallback }`. */
  payload: string;
  /** Set for a caregiver message: `userId` is then the OWNER of the caregiver row (for erasure). */
  caregiverId?: string;
  sourceMessageId: string;
  replyIndex: number;
  requestId: string;
  /**
   * WhatsApp ids of the parts already accepted by Meta. If the job is retried after a later
   * failure (e.g. the DB insert), already-sent parts are NOT sent again.
   */
  sentWaIds?: string[];
}
