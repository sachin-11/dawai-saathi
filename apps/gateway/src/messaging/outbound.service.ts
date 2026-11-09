import { Injectable } from '@nestjs/common';
import type { MessageType } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { redactText } from '../common/redaction/redact';
import { MessagesService } from './messages.service';
import { OutboundQueue } from './outbound.queue';
import type {
  OutboundContent,
  OutboundJobData,
  OutboundRequest,
  TemplateContent,
} from './outbound.types';
import { TemplateRegistry } from './template.registry';
import { splitText } from './text-splitter';
import { WhatsAppClient } from './whatsapp.client';
import { isWithinWindow, WindowClosedError } from './window';

/** The part of a BullMQ job `deliver` needs (keeps it easy to test without Redis). */
export interface OutboundJobLike {
  data: OutboundJobData;
  opts?: { priority?: number };
  updateData(data: OutboundJobData): Promise<void>;
}

interface StoredPayload {
  content: OutboundContent;
  templateFallback?: TemplateContent;
}

@Injectable()
export class OutboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly queue: OutboundQueue,
    private readonly client: WhatsAppClient,
    private readonly templates: TemplateRegistry,
    private readonly messages: MessagesService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboundService.name);
  }

  /**
   * Queue a message for a user. Nothing is sent inline: the `outbound` worker sends it, rate-limited
   * and retried. Idempotent per `(sourceMessageId, replyIndex)`.
   *
   * Fast-fails with WindowClosedError if a free-form message is requested outside the 24 h window
   * and there is no template fallback (checked again at send time, since the job may wait).
   */
  async enqueue(userId: string, request: OutboundRequest): Promise<void> {
    const caregiverId = request.recipient?.caregiverId;
    const lastInboundAt = caregiverId
      ? (
          await this.prisma.caregiver.findUniqueOrThrow({
            where: { id: caregiverId },
            select: { lastInboundAt: true },
          })
        ).lastInboundAt
      : (
          await this.prisma.user.findUniqueOrThrow({
            where: { id: userId },
            select: { lastInboundAt: true },
          })
        ).lastInboundAt;
    if (
      request.content.kind !== 'template' &&
      !request.templateFallback &&
      !isWithinWindow(lastInboundAt)
    ) {
      throw new WindowClosedError();
    }

    const payload: StoredPayload = {
      content: request.content,
      ...(request.templateFallback ? { templateFallback: request.templateFallback } : {}),
    };
    await this.queue.add(
      {
        userId,
        payload: this.crypto.encrypt(JSON.stringify(payload)),
        ...(caregiverId ? { caregiverId } : {}),
        sourceMessageId: request.sourceMessageId,
        replyIndex: request.replyIndex,
        requestId: request.requestId ?? '',
        ...(request.latency ? { latency: request.latency } : {}),
      },
      request.priority !== undefined ? { priority: request.priority } : {},
    );
  }

  /**
   * Execute one `outbound` job: decrypt the phone number (in memory only), apply the 24 h rule,
   * send via the Graph API and record the outbound message(s).
   *
   * Retry-safe: the WhatsApp id of every part Meta accepted is written back into the job data
   * right away, so a retry after a later failure never sends that part again, it only repeats the
   * (idempotent) database insert.
   */
  async deliver(job: OutboundJobLike): Promise<{ kind: OutboundContent['kind'] }> {
    const { userId, requestId } = job.data;
    const stored = JSON.parse(this.crypto.decrypt(job.data.payload)) as StoredPayload;

    const caregiverId = job.data.caregiverId;
    const user = caregiverId
      ? await this.prisma.caregiver.findUnique({
          where: { id: caregiverId },
          select: { waPhoneEnc: true, lastInboundAt: true },
        })
      : await this.prisma.user.findUnique({
          where: { id: userId },
          select: { waPhoneEnc: true, lastInboundAt: true },
        });
    if (!user) {
      // The user (or caregiver) was deleted while the job waited.
      throw new UnrecoverableError('recipient no longer exists');
    }

    let content: OutboundContent = stored.content;
    if (content.kind !== 'template' && !isWithinWindow(user.lastInboundAt)) {
      if (!stored.templateFallback) {
        throw new UnrecoverableError(new WindowClosedError().message);
      }
      this.logger.info(
        { request_id: requestId },
        '24h window closed, sending the template fallback',
      );
      content = stored.templateFallback;
    }

    const to = this.crypto.decrypt(user.waPhoneEnc);
    const options = requestId ? { requestId } : {};
    const sent = [...(job.data.sentWaIds ?? [])];

    const sendPart = async (
      index: number,
      type: MessageType,
      bodyRedacted: string,
      send: () => Promise<{ waMessageId: string }>,
    ): Promise<void> => {
      let waMessageId = sent[index];
      if (waMessageId === undefined) {
        waMessageId = (await send()).waMessageId;
        sent[index] = waMessageId;
        // Persist progress BEFORE the DB insert: if the insert fails, the retry will not resend.
        await job.updateData({ ...job.data, sentWaIds: [...sent] });
      }
      if (!caregiverId) {
        await this.messages.saveOutbound({ userId, waMessageId, type, bodyRedacted });
      }
    };

    switch (content.kind) {
      case 'text': {
        const parts = splitText(content.body);
        const previewUrl = content.previewUrl === true;
        for (const [index, part] of parts.entries()) {
          await sendPart(index, 'text', redactText(part), () =>
            this.client.sendText(to, part, {
              ...options,
              ...(previewUrl ? { previewUrl: true } : {}),
            }),
          );
        }
        break;
      }
      case 'buttons':
        await sendPart(0, 'button', redactText(content.body), () =>
          this.client.sendButtons(to, content.body, content.buttons, options),
        );
        break;
      case 'audio':
        await sendPart(0, 'audio', '[voice reply]', () =>
          this.client.sendAudio(to, content.mediaId, options),
        );
        break;
      case 'template': {
        const template = this.templates.build(
          content.template,
          content.language,
          content.params,
          content.buttonPayloads,
        );
        await sendPart(0, 'template', `[template:${template.name}]`, () =>
          this.client.sendTemplate(
            to,
            template.name,
            template.languageCode,
            template.components,
            options,
          ),
        );
        break;
      }
    }
    return { kind: content.kind };
  }
}
