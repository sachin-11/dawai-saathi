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

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
  /** Messages/statuses addressed to another phone number id (ignored). */
  foreignCount: number;
  /** Malformed messages/entries that were skipped. */
  invalidCount: number;
}
