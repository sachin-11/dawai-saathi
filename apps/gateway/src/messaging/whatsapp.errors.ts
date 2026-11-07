import { redactText } from '../common/redaction/redact';

/** Meta error codes we treat specially (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes). */
export const META_CODE = {
  /** Re-engagement message: the 24 h customer-service window is closed, a template is required. */
  REENGAGEMENT_REQUIRED: 131047,
  /** Message undeliverable (e.g. user blocked us, not on WhatsApp, unsupported client). */
  UNDELIVERABLE: 131026,
  /** Cloud API throughput / app-level rate limit. */
  RATE_LIMIT: 130429,
  /** Too many messages to the same user in a short time (pair rate limit). */
  PAIR_RATE_LIMIT: 131056,
  /** Generic "too many calls" (app level). */
  APP_RATE_LIMIT: 80007,
  /** OAuthException: access token invalid or expired. */
  INVALID_TOKEN: 190,
} as const;

const RATE_LIMIT_CODES = new Set<number>([
  META_CODE.RATE_LIMIT,
  META_CODE.PAIR_RATE_LIMIT,
  META_CODE.APP_RATE_LIMIT,
]);

export type WhatsAppErrorKind =
  | 'window_closed'
  | 'undeliverable'
  | 'rate_limit'
  | 'auth'
  | 'server'
  | 'network'
  | 'client'
  | 'invalid_response';

export interface WhatsAppApiErrorInit {
  httpStatus: number;
  kind: WhatsAppErrorKind;
  retryable: boolean;
  code?: number | undefined;
  subcode?: number | undefined;
  message: string;
  /** Server hint (Retry-After) in ms, if any. */
  retryAfterMs?: number | undefined;
}

/**
 * Typed error for every failed Graph API call. `retryable` tells the caller (BullMQ worker) whether
 * trying again can help; `window_closed` means "use a template instead", not "try again".
 * The message is redacted and truncated: Meta messages occasionally echo user-provided values.
 */
export class WhatsAppApiError extends Error {
  readonly httpStatus: number;
  readonly kind: WhatsAppErrorKind;
  readonly retryable: boolean;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: WhatsAppApiErrorInit) {
    super(redactText(init.message).slice(0, 300));
    this.name = 'WhatsAppApiError';
    this.httpStatus = init.httpStatus;
    this.kind = init.kind;
    this.retryable = init.retryable;
    this.code = init.code;
    this.subcode = init.subcode;
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** Thrown BEFORE any network call when our own input breaks a WhatsApp limit. Never retried. */
export class WhatsAppValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppValidationError';
  }
}

interface GraphErrorBody {
  error?: {
    message?: unknown;
    code?: unknown;
    error_subcode?: unknown;
  };
}

/** Build a WhatsAppApiError from a non-2xx Graph API response. */
export function fromGraphResponse(
  httpStatus: number,
  body: unknown,
  retryAfterMs?: number,
): WhatsAppApiError {
  const error = (body as GraphErrorBody | null)?.error;
  const code = typeof error?.code === 'number' ? error.code : undefined;
  const subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : undefined;
  const message =
    typeof error?.message === 'string' ? error.message : `Graph API error (HTTP ${httpStatus})`;
  const base = { httpStatus, code, subcode, message, retryAfterMs };

  if (code === META_CODE.REENGAGEMENT_REQUIRED) {
    return new WhatsAppApiError({ ...base, kind: 'window_closed', retryable: false });
  }
  if (code === META_CODE.UNDELIVERABLE) {
    return new WhatsAppApiError({ ...base, kind: 'undeliverable', retryable: false });
  }
  if (code === META_CODE.INVALID_TOKEN || httpStatus === 401) {
    return new WhatsAppApiError({ ...base, kind: 'auth', retryable: false });
  }
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || httpStatus === 429) {
    return new WhatsAppApiError({ ...base, kind: 'rate_limit', retryable: true });
  }
  if (httpStatus >= 500) {
    return new WhatsAppApiError({ ...base, kind: 'server', retryable: true });
  }
  return new WhatsAppApiError({ ...base, kind: 'client', retryable: false });
}

export function networkError(cause: string): WhatsAppApiError {
  return new WhatsAppApiError({
    httpStatus: 0,
    kind: 'network',
    retryable: true,
    message: `network error: ${cause}`,
  });
}
