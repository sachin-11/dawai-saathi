import { redactText } from '../common/redaction/redact';
import type { InboundMedia, InboundMessage, ParsedWebhook, StatusUpdate } from './inbound-message';
import {
  changeSchema,
  entrySchema,
  envelopeSchema,
  messageSchema,
  statusSchema,
  valueSchema,
  type WhatsAppMessage,
} from './whatsapp.schemas';

const DEFAULT_MIME = 'application/octet-stream';

function toMedia(media: {
  id: string;
  mime_type?: string;
  sha256?: string;
  filename?: string;
}): InboundMedia {
  return {
    id: media.id,
    mimeType: media.mime_type ?? DEFAULT_MIME,
    ...(media.sha256 ? { sha256: media.sha256 } : {}),
    // Filenames often contain a patient's name ("Ramesh_Sharma_Rx.pdf"): keep them redacted.
    ...(media.filename ? { filename: redactText(media.filename) } : {}),
  };
}

/** Map one Meta message to our internal type. Anything we do not handle becomes `unsupported`. */
export function normaliseMessage(raw: WhatsAppMessage): InboundMessage {
  const base = {
    waMessageId: raw.id,
    from: raw.from,
    timestamp: new Date(Number(raw.timestamp) * 1000),
  };

  switch (raw.type) {
    case 'text':
      if (raw.text) {
        return { ...base, type: 'text', text: raw.text.body };
      }
      break;
    case 'image':
    case 'document': {
      const media = raw[raw.type];
      if (media) {
        const caption = media.caption;
        return {
          ...base,
          type: raw.type,
          media: toMedia(media),
          ...(caption ? { text: caption } : {}),
        };
      }
      break;
    }
    case 'audio': // voice notes are `audio` with voice: true
      if (raw.audio) {
        return { ...base, type: 'audio', media: toMedia(raw.audio) };
      }
      break;
    case 'interactive':
      if (raw.interactive?.type === 'button_reply' && raw.interactive.button_reply) {
        const { id, title } = raw.interactive.button_reply;
        return { ...base, type: 'button', button: { id, title } };
      }
      break;
    case 'button':
      if (raw.button) {
        return {
          ...base,
          type: 'button',
          button: { id: raw.button.payload ?? raw.button.text, title: raw.button.text },
        };
      }
      break;
    default:
      break;
  }
  return { ...base, type: 'unsupported' };
}

/**
 * Turn a webhook body into normalised messages and status updates.
 * Pure function: no I/O, never throws on bad input (counts it in `invalidCount` instead), so the
 * controller can always answer 200 to a correctly signed request.
 */
export function parseWebhook(body: unknown, expectedPhoneNumberId: string): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [], foreignCount: 0, invalidCount: 0 };

  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    result.invalidCount += 1;
    return result;
  }

  for (const rawEntry of envelope.data.entry) {
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) {
      result.invalidCount += 1;
      continue;
    }

    for (const rawChange of entry.data.changes) {
      const change = changeSchema.safeParse(rawChange);
      if (!change.success) {
        result.invalidCount += 1;
        continue;
      }
      if (change.data.field !== 'messages') {
        continue; // other subscription fields (account_update, ...) are not our business
      }

      const value = valueSchema.safeParse(change.data.value);
      if (!value.success) {
        result.invalidCount += 1;
        continue;
      }
      const { metadata, messages = [], statuses = [] } = value.data;
      if (metadata.phone_number_id !== expectedPhoneNumberId) {
        result.foreignCount += messages.length + statuses.length;
        continue;
      }

      for (const rawMessage of messages) {
        const message = messageSchema.safeParse(rawMessage);
        if (message.success) {
          result.messages.push(normaliseMessage(message.data));
        } else {
          result.invalidCount += 1;
        }
      }

      for (const rawStatus of statuses) {
        const status = statusSchema.safeParse(rawStatus);
        if (status.success) {
          const errorCode = status.data.errors?.[0]?.code;
          const update: StatusUpdate = {
            waMessageId: status.data.id,
            status: status.data.status,
            ...(status.data.timestamp
              ? { timestamp: new Date(Number(status.data.timestamp) * 1000) }
              : {}),
            ...(errorCode !== undefined ? { errorCode } : {}),
          };
          result.statuses.push(update);
        } else {
          result.invalidCount += 1;
        }
      }
    }
  }
  return result;
}
