import { setTimeout as sleepMs } from 'node:timers/promises';

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { computeBackoffMs, fetchErrorCode } from '../messaging/whatsapp.retry';
import { AiServiceError } from './ai-client.errors';
import type {
  GenericDetailsRequest,
  GenericDetailsResponse,
  ProcessRequest,
  ProcessResponse,
} from './types';

export interface AiRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const DEFAULT_AI_RETRY_POLICY: AiRetryPolicy = {
  // One retry. The AI service already retries and falls back between LLM providers itself, so more
  // attempts here would multiply (not add to) the user's waiting time.
  maxAttempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
  sleep: (ms) => sleepMs(ms),
  random: Math.random,
};

/** Characters the AI service accepts in a request id (see `RequestId` in its contract). */
const REQUEST_ID_UNSAFE = /[^A-Za-z0-9._=+/-]/g;

/** WhatsApp message ids are safe already; this guarantees the contract regardless. */
export function toRequestId(value: string): string {
  const cleaned = value.replace(REQUEST_ID_UNSAFE, '_').slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

function isGenericDetailsResponse(value: unknown): value is GenericDetailsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as { reply?: { text?: unknown } | null };
  return (
    typeof body.reply === 'object' && body.reply !== null && typeof body.reply.text === 'string'
  );
}

function isProcessResponse(value: unknown): value is ProcessResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as { reply?: { text?: unknown; buttons?: unknown } | null; intent?: unknown };
  return (
    typeof body.intent === 'string' &&
    typeof body.reply === 'object' &&
    body.reply !== null &&
    typeof body.reply.text === 'string' &&
    Array.isArray(body.reply.buttons)
  );
}

/**
 * The ONLY class that talks to the AI service (CLAUDE.md §10: one client per external service).
 *
 * `POST /v1/process` is idempotent by `request_id`, so a failed call may be repeated, but only for
 * trouble that can clear up quickly: connection errors and 5xx. NOT retried: 4xx (our request is
 * wrong), timeouts and 504 (the AI service already used its whole time budget).
 * Logs: operation, status, latency, attempt, request id. Never the message text or the reply.
 */
@Injectable()
export class AiClient {
  /** Mutable so tests can inject a no-op sleep. */
  retryPolicy: AiRetryPolicy = { ...DEFAULT_AI_RETRY_POLICY };

  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiClient.name);
  }

  async process(request: ProcessRequest): Promise<ProcessResponse> {
    return this.post('/v1/process', 'ai.process', request, isProcessResponse);
  }

  /** The "Generic medicines" button: render the stored suggestions (no model call on the AI side). */
  async genericDetails(request: GenericDetailsRequest): Promise<GenericDetailsResponse> {
    return this.post(
      '/v1/generic-details',
      'ai.generic_details',
      request,
      isGenericDetailsResponse,
    );
  }

  private async post<Res>(
    path: string,
    operation: string,
    request: { request_id: string },
    isValid: (value: unknown) => value is Res,
  ): Promise<Res> {
    const policy = this.retryPolicy;
    const url = `${this.env.AI_SERVICE_URL.replace(/\/+$/, '')}${path}`;
    const body = JSON.stringify(request);

    for (let attempt = 1; ; attempt++) {
      const startedAt = performance.now();
      let response: Response;
      const signal = AbortSignal.timeout(this.env.AI_CLIENT_TIMEOUT_MS);
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Token': this.env.SERVICE_TOKEN,
            'X-Request-Id': toRequestId(request.request_id),
          },
          body,
          signal,
        });
      } catch (error) {
        // The signal is the source of truth: fetch wraps the abort reason differently per runtime.
        const timedOut = signal.aborted;
        const failure = timedOut
          ? new AiServiceError('timeout', undefined, undefined)
          : new AiServiceError('connection', undefined, undefined);
        this.log(operation, request, attempt, startedAt, {
          outcome: failure.kind,
          error_code: fetchErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'),
        });
        if (timedOut || attempt >= policy.maxAttempts) throw failure;
        await policy.sleep(computeBackoffMs(attempt, policy));
        continue;
      }

      if (response.ok) {
        const parsed: unknown = await response.json().catch(() => null);
        if (!isValid(parsed)) {
          this.log(operation, request, attempt, startedAt, {
            status: response.status,
            outcome: 'invalid',
          });
          throw new AiServiceError('invalid_response', response.status, undefined);
        }
        this.log(operation, request, attempt, startedAt, { status: response.status });
        return parsed;
      }

      const errorBody: unknown = await response.json().catch(() => null);
      const code = (errorBody as { error?: { code?: unknown } } | null)?.error?.code;
      const errorCode = typeof code === 'string' ? code : undefined;
      const failure = new AiServiceError(
        response.status === 401 ? 'unauthorized' : response.status >= 500 ? 'server' : 'client',
        response.status,
        errorCode,
      );
      this.log(operation, request, attempt, startedAt, {
        status: response.status,
        ai_error_code: errorCode,
      });

      const retryable = response.status >= 500 && response.status !== 504;
      if (!retryable || attempt >= policy.maxAttempts) throw failure;
      await policy.sleep(computeBackoffMs(attempt, policy));
    }
  }

  private log(
    operation: string,
    request: { request_id: string },
    attempt: number,
    startedAt: number,
    fields: Record<string, unknown>,
  ): void {
    this.logger.info(
      {
        operation,
        request_id: toRequestId(request.request_id),
        attempt,
        latency_ms: Math.round(performance.now() - startedAt),
        ...fields,
      },
      'ai service call',
    );
  }
}
