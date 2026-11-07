import { computeBackoffMs, fetchErrorCode, isConnectPhaseError } from './whatsapp.retry';

const policy = { baseDelayMs: 500, maxDelayMs: 8_000, random: () => 0 };

describe('computeBackoffMs', () => {
  it('grows exponentially (with the jitter at its minimum = half the exponential delay)', () => {
    expect([1, 2, 3, 4].map((attempt) => computeBackoffMs(attempt, policy))).toEqual([
      250, 500, 1000, 2000,
    ]);
  });

  it('adds jitter on top: between half and the full exponential delay', () => {
    const low = computeBackoffMs(3, { ...policy, random: () => 0 });
    const high = computeBackoffMs(3, { ...policy, random: () => 0.999 });
    expect(low).toBe(1000);
    expect(high).toBeGreaterThan(1900);
    expect(high).toBeLessThanOrEqual(2000);
  });

  it('is capped at maxDelayMs', () => {
    expect(computeBackoffMs(20, { ...policy, random: () => 0.999 })).toBeLessThanOrEqual(8_000);
  });

  it('uses a longer base for rate limits', () => {
    const normal = computeBackoffMs(1, policy);
    const limited = computeBackoffMs(1, policy, { rateLimited: true, rateLimitBaseDelayMs: 2_000 });
    expect(limited).toBeGreaterThan(normal);
  });

  it('honours Retry-After when it is longer than the computed delay', () => {
    expect(computeBackoffMs(1, policy, { retryAfterMs: 20_000 })).toBe(20_000);
    expect(computeBackoffMs(4, policy, { retryAfterMs: 10 })).toBe(2000);
  });
});

describe('fetch error classification', () => {
  const failure = (code: string): Error =>
    Object.assign(new TypeError('fetch failed'), { cause: { code } });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    '%s is a connect-phase error (safe to retry a send)',
    (code) => {
      expect(isConnectPhaseError(failure(code))).toBe(true);
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'])(
    '%s is ambiguous (the request may have been delivered)',
    (code) => {
      expect(isConnectPhaseError(failure(code))).toBe(false);
    },
  );

  it('an abort/timeout is ambiguous too', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(isConnectPhaseError(timeout)).toBe(false);
  });

  it('also accepts a code on the error itself (what HTTP mocks reject with)', () => {
    expect(fetchErrorCode({ code: 'ECONNREFUSED' })).toBe('ECONNREFUSED');
    expect(isConnectPhaseError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isConnectPhaseError({ code: 'ECONNRESET' })).toBe(false);
  });

  it('reads the code from error.cause', () => {
    expect(fetchErrorCode(failure('ECONNREFUSED'))).toBe('ECONNREFUSED');
    expect(fetchErrorCode(new Error('x'))).toBeUndefined();
    expect(fetchErrorCode(null)).toBeUndefined();
  });
});
