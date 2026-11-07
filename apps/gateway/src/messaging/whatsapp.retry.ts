import { setTimeout as sleepMs } from 'node:timers/promises';

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Rate-limit responses back off from a longer base. */
  rateLimitBaseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Injectable so tests are deterministic. */
  random: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  rateLimitBaseDelayMs: 2_000,
  sleep: (ms) => sleepMs(ms),
  random: Math.random,
};

/**
 * Exponential backoff with "equal jitter": half of the exponential delay is fixed and half is
 * random, so many workers retrying together do not all hit Meta in the same millisecond.
 * `attempt` is the number of the attempt that just failed (1-based). A server-sent Retry-After wins
 * if it is longer.
 */
export function computeBackoffMs(
  attempt: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs' | 'random'>,
  options: { rateLimited?: boolean; rateLimitBaseDelayMs?: number; retryAfterMs?: number } = {},
): number {
  const base = options.rateLimited
    ? (options.rateLimitBaseDelayMs ?? policy.baseDelayMs)
    : policy.baseDelayMs;
  const exponential = Math.min(policy.maxDelayMs, base * 2 ** (attempt - 1));
  const jittered = exponential / 2 + (policy.random() * exponential) / 2;
  return Math.max(Math.round(jittered), options.retryAfterMs ?? 0);
}

/** Connection-phase failures: the request never reached Meta, so retrying cannot double-send. */
const CONNECT_PHASE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Error code of a failed `fetch`. Node wraps the real cause in `error.cause` (`TypeError: fetch
 * failed`); some HTTP mocks reject with the code directly, so both places are checked.
 */
export function fetchErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  if (typeof candidate?.cause?.code === 'string') {
    return candidate.cause.code;
  }
  return typeof candidate?.code === 'string' ? candidate.code : undefined;
}

export function isConnectPhaseError(error: unknown): boolean {
  const code = fetchErrorCode(error);
  return code !== undefined && CONNECT_PHASE_CODES.has(code);
}
