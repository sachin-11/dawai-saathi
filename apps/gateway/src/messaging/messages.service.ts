import { Injectable } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { redactText } from '../common/redaction/redact';
import type { InboundMessage } from '../webhook/inbound-message';

export interface SavedMessage {
  id: string;
  userId: string;
  /** True when this WhatsApp message id had already been stored (Meta redelivery). */
  duplicate: boolean;
}

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Store an inbound message. Idempotent on `wa_message_id`: Meta delivers at-least-once, so the
   * insert is `ON CONFLICT DO NOTHING` and a redelivery returns the existing row with
   * `duplicate: true` (the caller still enqueues, which BullMQ's jobId turns into a no-op).
   *
   * Only redacted text is stored (`body_redacted`); the media is not downloaded yet (M3), so
   * `media_s3_key` stays null and the media id travels in the queue job instead.
   */
  async saveInbound(userId: string, message: InboundMessage): Promise<SavedMessage> {
    const bodyRedacted = this.bodyFor(message);

    const inserted = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO messages (user_id, direction, wa_message_id, type, body_redacted)
      VALUES (${userId}::uuid, 'in', ${message.waMessageId},
              ${message.type}::message_type, ${bodyRedacted})
      ON CONFLICT (wa_message_id) DO NOTHING
      RETURNING id::text`;
    const created = inserted[0];
    if (created) {
      return { id: created.id, userId, duplicate: false };
    }

    const existing = await this.prisma.message.findUniqueOrThrow({
      where: { waMessageId: message.waMessageId },
      select: { id: true, userId: true },
    });
    return { id: existing.id, userId: existing.userId, duplicate: true };
  }

  private bodyFor(message: InboundMessage): string | null {
    const raw = message.text ?? message.button?.title;
    return raw === undefined ? null : redactText(raw);
  }
}
