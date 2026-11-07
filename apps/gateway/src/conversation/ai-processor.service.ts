import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../audit/audit.service';
import { AiClient, toRequestId } from '../ai-client/ai-client';
import type { ProcessRequest, ProcessResponse } from '../ai-client/types';
import { StorageService } from '../common/storage/storage.service';
import { MediaService } from '../messaging/media.service';
import { MessagesService } from '../messaging/messages.service';
import { MAX_INTERACTIVE_BODY_LENGTH, WhatsAppClient } from '../messaging/whatsapp.client';
import type { InboundJobData } from '../queues/queue.constants';
import { type UserState, UsersService } from '../users/users.service';
import type { ReplySession } from './replies.service';

/** Presigned media URLs handed to the AI service live for 5 minutes (CLAUDE.md §12). */
export const PRESIGNED_URL_TTL_SECONDS = 300;

/**
 * The error reply uses a fixed, high reply index. Together with the deterministic outbound job id
 * (`<messageId>_<index>`) the user gets AT MOST ONE error message per inbound message, no matter how
 * many times the job is retried.
 */
export const AI_ERROR_REPLY_INDEX = 99;

export type AiOutcome = 'ai_reply' | 'ai_emergency' | 'media_rejected' | 'unsupported';

/**
 * The branch of the router for a consented user's ordinary message (CLAUDE.md §7.2):
 *   media: immediate acknowledgement + blue ticks -> store the file -> presigned URL
 *   text:  the redacted text stored by the webhook
 * then ONE call to the AI service and the reply goes out through the outbound queue.
 *
 * Failures after the acknowledgement send a single "please try again" message and rethrow, so the
 * inbound job is retried by BullMQ's normal policy.
 */
@Injectable()
export class AiProcessor {
  constructor(
    private readonly ai: AiClient,
    private readonly messages: MessagesService,
    private readonly media: MediaService,
    private readonly storage: StorageService,
    private readonly users: UsersService,
    private readonly whatsapp: WhatsAppClient,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiProcessor.name);
  }

  async handle(user: UserState, job: InboundJobData, session: ReplySession): Promise<AiOutcome> {
    if (job.type === 'unsupported' || job.type === 'button') {
      await session.text('common.unsupported_type');
      return 'unsupported';
    }

    const isMedia = job.type === 'image' || job.type === 'document' || job.type === 'audio';
    try {
      if (isMedia) {
        // Within seconds of the job starting (CLAUDE.md §7.2): ack first, work afterwards.
        await session.text('common.received_processing');
        await this.markAsReadQuietly(job);
      }

      const input = isMedia ? await this.mediaInput(user, job, session) : await this.textInput(job);
      if (input === 'rejected') return 'media_rejected';
      if (input === null) {
        await session.text('common.unsupported_type');
        return 'unsupported';
      }

      const request = await this.buildRequest(user, job, input);
      const response = await this.ai.process(request);
      if (response.emergency) {
        // Highest queue priority, plain text (never buttons), and nothing else happens for this message.
        await session.rawEmergencyText(response.reply.text);
        await this.auditEmergency(user, response);
        this.logResponse(job, response);
        return 'ai_emergency';
      }
      await this.sendReply(response, session);
      this.logResponse(job, response);
      return 'ai_reply';
    } catch (error) {
      // One user-visible error per inbound message (fixed reply index), then let BullMQ retry.
      await session.textAt(AI_ERROR_REPLY_INDEX, 'common.error_try_again').catch(() => undefined);
      throw error;
    }
  }

  // ------------------------------------------------------------------ inputs

  private async textInput(job: InboundJobData): Promise<ProcessRequest['input'] | null> {
    // The webhook stored the REDACTED text (phone numbers, Aadhaar-like numbers, emails, PINs
    // removed): that is what the AI service gets. The raw text exists nowhere.
    const message = await this.messages.findInboundForReply(job.messageId);
    const text = message?.bodyRedacted?.trim();
    return text ? { type: 'text', text } : null;
  }

  private async mediaInput(
    user: UserState,
    job: InboundJobData,
    session: ReplySession,
  ): Promise<ProcessRequest['input'] | 'rejected' | null> {
    if (!job.media) return null;
    const stored = await this.media.storeInboundMedia({
      messageId: job.messageId,
      userId: user.id,
      mediaId: job.media.id,
      requestId: job.requestId,
    });
    if (stored.status === 'rejected') {
      await session.text(
        stored.reason === 'too_large' ? 'common.file_too_large' : 'common.unsupported_type',
        stored.reason === 'too_large' ? { max_mb: this.maxMediaMb() } : {},
      );
      return 'rejected';
    }
    const mediaUrl = await this.storage.getPresignedUrl(stored.key, PRESIGNED_URL_TTL_SECONDS);
    return {
      // The contract knows image | text | audio; photos and PDFs of documents are "image".
      type: job.type === 'audio' ? 'audio' : 'image',
      media_url: mediaUrl,
      mime: stored.mimeType,
    };
  }

  private maxMediaMb(): number {
    return this.media.maxMediaMb;
  }

  private async buildRequest(
    user: UserState,
    job: InboundJobData,
    input: ProcessRequest['input'],
  ): Promise<ProcessRequest> {
    return {
      request_id: toRequestId(job.waMessageId),
      user: { language: user.language, age: null, sex: null },
      input,
      context: { active_medications: await this.users.activeMedicationSalts(user.id) },
    };
  }

  // ------------------------------------------------------------------ output

  private async sendReply(response: ProcessResponse, session: ReplySession): Promise<void> {
    const { text } = response.reply;
    const buttons = response.reply.buttons ?? [];
    if (buttons.length > 0 && text.length <= MAX_INTERACTIVE_BODY_LENGTH) {
      await session.rawButtons(text, buttons);
      return;
    }
    // WhatsApp button messages carry at most 1024 characters of body: longer replies go as text.
    await session.rawText(text);
  }

  /** The category only: never the text. A failing audit write must not hide the help message. */
  private async auditEmergency(user: UserState, response: ProcessResponse): Promise<void> {
    try {
      await this.audit.log({
        actor: 'system',
        userId: user.id,
        action: 'emergency_detected',
        metadata: { category: response.emergency_category ?? 'unknown' },
      });
    } catch {
      this.logger.error({ user_id: user.id }, 'could not write the emergency audit entry');
    }
  }

  private async markAsReadQuietly(job: InboundJobData): Promise<void> {
    try {
      await this.whatsapp.markAsRead(job.waMessageId, { requestId: job.requestId });
    } catch {
      // Blue ticks are a courtesy; never let them block processing.
      this.logger.warn({ request_id: job.requestId }, 'could not mark the message as read');
    }
  }

  private logResponse(job: InboundJobData, response: ProcessResponse): void {
    // Numbers and ids only: never the text of the message or of the reply.
    this.logger.info(
      {
        request_id: job.requestId,
        intent: response.intent,
        emergency: response.emergency,
        model: response.meta.model,
        provider: response.meta.provider,
        fallback_used: response.meta.fallback_used,
        latency_ms: response.meta.latency_ms,
        cost_usd: response.meta.cost_usd,
        trace_id: response.meta.trace_id,
      },
      'ai reply received',
    );
  }
}
