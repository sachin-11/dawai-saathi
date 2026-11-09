import { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import {
  WhatsAppApiError,
  WhatsAppValidationError,
  fromGraphResponse,
  networkError,
} from './whatsapp.errors';
import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  computeBackoffMs,
  fetchErrorCode,
  isConnectPhaseError,
} from './whatsapp.retry';
import { MAX_TEXT_LENGTH } from './text-splitter';

export const REQUEST_TIMEOUT_MS = 10_000;
/** Media downloads stream a whole file, so they get a longer overall budget. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Limits enforced by the WhatsApp interactive-message API. */
export const MAX_BUTTONS = 3;
export const MAX_BUTTON_ID_LENGTH = 256;
export const MAX_BUTTON_TITLE_LENGTH = 20;
export const MAX_INTERACTIVE_BODY_LENGTH = 1024;

/**
 * Media download URLs come from Meta's response and we attach our bearer token to them. Only send
 * the token to Meta-owned hosts over HTTPS, never to whatever host a response happens to name.
 */
const ALLOWED_MEDIA_HOST_SUFFIXES = ['.fbsbx.com', '.facebook.com', '.whatsapp.net', '.fbcdn.net'];

export function isAllowedMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      ALLOWED_MEDIA_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

export interface CallOptions {
  /** Correlates log lines with the webhook / job that caused the call. */
  requestId?: string;
}

export interface ReplyButton {
  id: string;
  title: string;
}

export type TemplateComponent =
  | { type: 'body'; parameters: { type: 'text'; text: string }[] }
  | {
      type: 'button';
      sub_type: 'quick_reply';
      index: string;
      parameters: { type: 'payload'; payload: string }[];
    };

export interface SendResult {
  waMessageId: string;
}

export interface MediaInfo {
  url: string;
  mimeType: string;
  fileSize: number | undefined;
  sha256: string | undefined;
}

export interface MediaDownload {
  stream: Readable;
  contentLength: number | undefined;
  contentType: string | undefined;
}

const sendResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).min(1),
});
const mediaInfoSchema = z.object({
  url: z.string(),
  mime_type: z.string(),
  file_size: z.coerce.number().optional(),
  sha256: z.string().optional(),
});

/** WhatsApp accepts audio uploads up to 16 MB; a spoken reply is a few hundred KB. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

const uploadResponseSchema = z.object({ id: z.string().min(1) });

interface InternalCall<T> {
  operation: string;
  url: string;
  init: RequestInit;
  /**
   * Read-only / idempotent calls may be retried after ANY failure. Sends may not: a timeout after
   * the request left our machine is ambiguous (Meta may have delivered it), and the API has no
   * idempotency key, so for sends only failures that provably did not reach Meta are retried.
   */
  idempotent: boolean;
  timeoutMs: number;
  requestId: string | undefined;
  parse: (response: Response) => Promise<T>;
}

/**
 * The ONLY class that talks to the WhatsApp Cloud API (CLAUDE.md §10: one client per external
 * service, with timeout, retry + jitter and structured errors).
 *
 * Logging rules: never the access token, phone numbers or message bodies. Only the operation name,
 * HTTP status, Meta error code, latency, attempt number and request id.
 */
@Injectable()
export class WhatsAppClient {
  /** Mutable so tests can inject a no-op sleep and a deterministic random. */
  retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY };

  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WhatsAppClient.name);
  }

  // ------------------------------------------------------------------ sending

  /** One text message (at most 4096 characters; use `splitText` for longer text). */
  sendText(
    to: string,
    body: string,
    options: CallOptions & { previewUrl?: boolean } = {},
  ): Promise<SendResult> {
    if (body.trim().length === 0) {
      throw new WhatsAppValidationError('text body must not be empty');
    }
    if (body.length > MAX_TEXT_LENGTH) {
      throw new WhatsAppValidationError(`text body exceeds ${MAX_TEXT_LENGTH} characters`);
    }
    return this.send(
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body, preview_url: options.previewUrl ?? false },
      },
      options,
    );
  }

  /** Interactive reply buttons: 1–3 buttons, id ≤ 256 chars, title ≤ 20 chars. */
  sendButtons(
    to: string,
    body: string,
    buttons: readonly ReplyButton[],
    options: CallOptions = {},
  ): Promise<SendResult> {
    if (body.trim().length === 0 || body.length > MAX_INTERACTIVE_BODY_LENGTH) {
      throw new WhatsAppValidationError(
        `button message body must be 1–${MAX_INTERACTIVE_BODY_LENGTH} characters`,
      );
    }
    if (buttons.length < 1 || buttons.length > MAX_BUTTONS) {
      throw new WhatsAppValidationError(`a message can have 1–${MAX_BUTTONS} buttons`);
    }
    const ids = new Set<string>();
    for (const button of buttons) {
      if (button.id.length < 1 || button.id.length > MAX_BUTTON_ID_LENGTH) {
        throw new WhatsAppValidationError(`button id must be 1–${MAX_BUTTON_ID_LENGTH} characters`);
      }
      if (button.title.length < 1 || button.title.length > MAX_BUTTON_TITLE_LENGTH) {
        throw new WhatsAppValidationError(
          `button title must be 1–${MAX_BUTTON_TITLE_LENGTH} characters`,
        );
      }
      if (ids.has(button.id)) {
        throw new WhatsAppValidationError('button ids must be unique');
      }
      ids.add(button.id);
    }
    return this.send(
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: buttons.map((button) => ({
              type: 'reply',
              reply: { id: button.id, title: button.title },
            })),
          },
        },
      },
      options,
    );
  }

  /** Pre-approved template message (the only kind allowed outside the 24 h window). */
  sendTemplate(
    to: string,
    name: string,
    languageCode: string,
    components: readonly TemplateComponent[],
    options: CallOptions = {},
  ): Promise<SendResult> {
    return this.send(
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name,
          language: { code: languageCode },
          ...(components.length > 0 ? { components } : {}),
        },
      },
      options,
    );
  }

  /**
   * M13: an audio message (a spoken reply) from a media id that `uploadMedia` returned. Ogg/Opus mono
   * is what WhatsApp plays as a voice message.
   */
  sendAudio(to: string, mediaId: string, options: CallOptions = {}): Promise<SendResult> {
    if (!/^[A-Za-z0-9_-]+$/.test(mediaId)) {
      throw new WhatsAppValidationError('invalid media id');
    }
    return this.send(
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'audio',
        audio: { id: mediaId },
      },
      options,
    );
  }

  /** Show blue ticks for an inbound message while we are still processing it. */
  async markAsRead(waMessageId: string, options: CallOptions = {}): Promise<void> {
    await this.call({
      operation: 'messages.read',
      url: this.messagesUrl(),
      init: this.postJson({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
      }),
      idempotent: true,
      timeoutMs: REQUEST_TIMEOUT_MS,
      requestId: options.requestId,
      parse: async (response) => {
        await response.arrayBuffer();
      },
    });
  }

  // ------------------------------------------------------------------ media

  /** Look up a media id. The returned URL expires within minutes: download it right away. */
  async getMediaUrl(mediaId: string, options: CallOptions = {}): Promise<MediaInfo> {
    if (!/^[A-Za-z0-9_-]+$/.test(mediaId)) {
      throw new WhatsAppValidationError('invalid media id');
    }
    return this.call({
      operation: 'media.get',
      url: `${this.baseUrl()}/${mediaId}`,
      init: { method: 'GET' },
      idempotent: true,
      timeoutMs: REQUEST_TIMEOUT_MS,
      requestId: options.requestId,
      parse: async (response) => {
        const parsed = mediaInfoSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw this.invalidResponse(response.status);
        }
        return {
          url: parsed.data.url,
          mimeType: parsed.data.mime_type,
          fileSize: parsed.data.file_size,
          sha256: parsed.data.sha256,
        };
      },
    });
  }

  /**
   * M13: upload a file (a spoken reply) and get its media id. Uploading is safe to repeat: a retry can
   * only create one more unused media id, never a second message.
   */
  async uploadMedia(
    data: Uint8Array,
    mimeType: string,
    options: CallOptions = {},
  ): Promise<{ mediaId: string }> {
    if (data.byteLength === 0 || data.byteLength > MAX_UPLOAD_BYTES) {
      throw new WhatsAppValidationError(`media upload must be 1–${MAX_UPLOAD_BYTES} bytes`);
    }
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([data], { type: mimeType }), 'reply.ogg');
    return this.call({
      operation: 'media.upload',
      url: `${this.baseUrl()}/${this.env.WA_PHONE_NUMBER_ID}/media`,
      init: { method: 'POST', body: form },
      idempotent: true,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      requestId: options.requestId,
      parse: async (response) => {
        const parsed = uploadResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw this.invalidResponse(response.status);
        }
        return { mediaId: parsed.data.id };
      },
    });
  }

  /** Stream a media file. Needs the same bearer token; only Meta-owned HTTPS hosts are accepted. */
  downloadMedia(url: string, options: CallOptions = {}): Promise<MediaDownload> {
    if (!isAllowedMediaUrl(url)) {
      throw new WhatsAppValidationError('media url is not an allowed Meta HTTPS host');
    }
    return this.call({
      operation: 'media.download',
      url,
      init: { method: 'GET' },
      idempotent: true,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      requestId: options.requestId,
      parse: (response) => {
        if (!response.body) {
          throw this.invalidResponse(response.status);
        }
        const length = Number(response.headers.get('content-length'));
        return Promise.resolve({
          // Web stream -> Node stream, so it can be piped into the S3 upload without buffering.
          stream: Readable.fromWeb(response.body),
          contentLength: Number.isFinite(length) && length > 0 ? length : undefined,
          contentType: response.headers.get('content-type') ?? undefined,
        });
      },
    });
  }

  // ------------------------------------------------------------------ internals

  private baseUrl(): string {
    return `${this.env.WA_API_BASE_URL.replace(/\/+$/, '')}/${this.env.WA_API_VERSION}`;
  }

  private messagesUrl(): string {
    return `${this.baseUrl()}/${this.env.WA_PHONE_NUMBER_ID}/messages`;
  }

  private postJson(payload: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }

  private async send(payload: unknown, options: CallOptions): Promise<SendResult> {
    return this.call({
      operation: 'messages.send',
      url: this.messagesUrl(),
      init: this.postJson(payload),
      idempotent: false,
      timeoutMs: REQUEST_TIMEOUT_MS,
      requestId: options.requestId,
      parse: async (response) => {
        const parsed = sendResponseSchema.safeParse(await response.json());
        const id = parsed.success ? parsed.data.messages[0]?.id : undefined;
        if (!id) {
          // Meta accepted the message but the answer is unreadable: resending would duplicate it.
          throw this.invalidResponse(response.status);
        }
        return { waMessageId: id };
      },
    });
  }

  private invalidResponse(httpStatus: number): WhatsAppApiError {
    return new WhatsAppApiError({
      httpStatus,
      kind: 'invalid_response',
      retryable: false,
      message: 'unexpected response from the Graph API',
    });
  }

  /** Request with timeout, bearer auth, typed errors and bounded retry with backoff + jitter. */
  private async call<T>(call: InternalCall<T>): Promise<T> {
    const policy = this.retryPolicy;

    for (let attempt = 1; ; attempt++) {
      const startedAt = performance.now();
      let response: Response;
      try {
        response = await fetch(call.url, {
          ...call.init,
          headers: {
            ...(call.init.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${this.env.WA_ACCESS_TOKEN}`,
          },
          signal: AbortSignal.timeout(call.timeoutMs),
        });
      } catch (error) {
        const code = fetchErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown');
        this.log(call, attempt, startedAt, { outcome: 'network_error', error_code: code });
        const retryable = call.idempotent || isConnectPhaseError(error);
        if (!retryable || attempt >= policy.maxAttempts) {
          throw networkError(code);
        }
        await policy.sleep(computeBackoffMs(attempt, policy));
        continue;
      }

      if (response.ok) {
        this.log(call, attempt, startedAt, { status: response.status });
        return call.parse(response);
      }

      const retryAfter = Number(response.headers.get('retry-after'));
      const apiError = fromGraphResponse(
        response.status,
        await response.json().catch(() => null),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
      this.log(call, attempt, startedAt, {
        status: apiError.httpStatus,
        meta_code: apiError.code,
        error_kind: apiError.kind,
      });
      if (apiError.kind === 'auth') {
        // Needs a human (token expired or revoked); an ops alert hooks in here in M15.
        this.logger.error(
          { operation: call.operation, meta_code: apiError.code },
          'WhatsApp access token rejected (invalid or expired)',
        );
      }

      // The client only retries transport-level trouble: HTTP 429 and 5xx. Meta's code-based rate
      // limits (130429, 131056 arrive as HTTP 400) are flagged `retryable` for the queue, which
      // backs off for much longer than is sensible inside a single request.
      const retryHere =
        apiError.kind === 'server' ||
        (apiError.kind === 'rate_limit' && apiError.httpStatus === 429);
      if (!retryHere || attempt >= policy.maxAttempts) {
        throw apiError;
      }
      await policy.sleep(
        computeBackoffMs(attempt, policy, {
          rateLimited: apiError.kind === 'rate_limit',
          rateLimitBaseDelayMs: policy.rateLimitBaseDelayMs,
          ...(apiError.retryAfterMs !== undefined ? { retryAfterMs: apiError.retryAfterMs } : {}),
        }),
      );
    }
  }

  private log(
    call: InternalCall<unknown>,
    attempt: number,
    startedAt: number,
    fields: Record<string, unknown>,
  ): void {
    this.logger.info(
      {
        operation: call.operation,
        attempt,
        latency_ms: Math.round(performance.now() - startedAt),
        ...(call.requestId ? { request_id: call.requestId } : {}),
        ...fields,
      },
      'whatsapp api call',
    );
  }
}
