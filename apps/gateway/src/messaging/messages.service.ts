import { Injectable } from '@nestjs/common';
import type { DeliveryStatus, MessageType } from '@prisma/client';

import { PrismaService } from '../common/prisma/prisma.service';
import { redactText } from '../common/redaction/redact';
import type { InboundMessage } from '../webhook/inbound-message';

export type StatusApplyResult = 'updated' | 'ignored' | 'not_found';

/**
 * Which previous states a new delivery status may replace. A status only ever moves forward
 * (sent -> delivered -> read); `failed` never overwrites a delivered/read message, and a late
 * `sent` never undoes anything. Webhooks can arrive out of order, so this is the whole defence.
 */
const ALLOWED_PREVIOUS: Readonly<Record<DeliveryStatus, readonly (DeliveryStatus | null)[]>> = {
  sent: [null],
  delivered: [null, 'sent'],
  read: [null, 'sent', 'delivered'],
  failed: [null, 'sent'],
};

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

  /**
   * Record an OUTBOUND message we just sent. `waMessageId` comes from Meta's response. Idempotent
   * (`ON CONFLICT DO NOTHING`), so a retried job that already sent the message can safely call it
   * again. Only redacted text is stored.
   */
  async saveOutbound(input: {
    userId: string;
    waMessageId: string;
    type: MessageType;
    bodyRedacted: string | null;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO messages (user_id, direction, wa_message_id, type, body_redacted)
      VALUES (${input.userId}::uuid, 'out', ${input.waMessageId},
              ${input.type}::message_type, ${input.bodyRedacted})
      ON CONFLICT (wa_message_id) DO NOTHING`;
  }

  /**
   * Apply a delivery receipt from a status webhook to our outbound row.
   *  - 'updated'    the row moved forward
   *  - 'ignored'    row exists but the status is a duplicate or an out-of-order downgrade
   *  - 'not_found'  no such outbound row (yet: a fast `delivered` can beat our own insert)
   */
  async applyStatus(input: {
    waMessageId: string;
    status: DeliveryStatus;
    at: Date;
    errorCode?: string | undefined;
  }): Promise<StatusApplyResult> {
    const previous = ALLOWED_PREVIOUS[input.status];
    const concreteStates = previous.filter((state): state is DeliveryStatus => state !== null);
    const result = await this.prisma.message.updateMany({
      where: {
        waMessageId: input.waMessageId,
        direction: 'out',
        OR: [
          ...(previous.includes(null) ? [{ deliveryStatus: null }] : []),
          { deliveryStatus: { in: concreteStates } },
        ],
      },
      data: {
        deliveryStatus: input.status,
        statusUpdatedAt: input.at,
        errorCode: input.status === 'failed' ? (input.errorCode ?? null) : null,
      },
    });
    if (result.count > 0) {
      return 'updated';
    }
    const exists = await this.prisma.message.count({
      where: { waMessageId: input.waMessageId, direction: 'out' },
    });
    return exists > 0 ? 'ignored' : 'not_found';
  }

  /** Remember where the downloaded media of an inbound message was stored. */
  async setMediaKey(messageId: string, mediaS3Key: string): Promise<void> {
    await this.prisma.message.update({ where: { id: messageId }, data: { mediaS3Key } });
  }

  /** What the (dev) echo bot needs about an inbound message: its redacted text and the user's language. */
  async findInboundForReply(messageId: string): Promise<{
    id: string;
    userId: string;
    waMessageId: string;
    bodyRedacted: string | null;
    language: 'hi' | 'en';
  } | null> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        userId: true,
        waMessageId: true,
        bodyRedacted: true,
        user: { select: { language: true } },
      },
    });
    return message
      ? {
          id: message.id,
          userId: message.userId,
          waMessageId: message.waMessageId,
          bodyRedacted: message.bodyRedacted,
          language: message.user.language,
        }
      : null;
  }
}
