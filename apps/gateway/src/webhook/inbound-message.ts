/** Internal, provider-independent shape of a WhatsApp message we received. */
export type InboundMessageType = 'text' | 'image' | 'document' | 'audio' | 'button' | 'unsupported';

export interface InboundMedia {
  id: string;
  mimeType: string;
  sha256?: string;
  filename?: string;
}

export interface InboundButton {
  id: string;
  title: string;
}

export interface InboundMessage {
  waMessageId: string;
  /** Sender as E.164 digits. Lives only in memory: hash/encrypt it, never log or queue it. */
  from: string;
  timestamp: Date;
  type: InboundMessageType;
  /** Text body, or the caption of an image/document. */
  text?: string;
  media?: InboundMedia;
  /** From `interactive.button_reply` and the legacy `button` message. */
  button?: InboundButton;
}

/** A delivery receipt for one of OUR outbound messages (not a user message). */
export interface StatusUpdate {
  waMessageId: string;
  status: string;
  /** When Meta recorded the status. */
  timestamp?: Date;
  /** First error code, if Meta reported a failure. Error text is not kept (may contain PII). */
  errorCode?: number;
}

/**
 * M15: events about the NUMBER or its templates (not about a user): quality rating changes, messaging
 * limit tier changes, template approvals / rejections. Machine tokens only.
 */
export interface AccountEvent {
  kind: 'quality' | 'account' | 'template';
  /** Upper-case Meta event token (`DOWNGRADE`, `REJECTED`, ...), or `OTHER`. */
  event: string;
  /** Messaging tier token such as `TIER_1K`, when Meta sends one. */
  limit?: string;
  /** Template name (lower-case, digits, underscore), for template events. */
  templateName?: string;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  /** M15: number / template health events. */
  accountEvents: AccountEvent[];
  statuses: StatusUpdate[];
  /** Messages/statuses addressed to another phone number id (ignored). */
  foreignCount: number;
  /** Malformed messages/entries that were skipped. */
  invalidCount: number;
}
