import { UnrecoverableError } from 'bullmq';

import { CryptoError } from '../common/crypto/crypto.util';
import { outboundBackoffMs, toUnrecoverable } from './outbound.worker';
import { WhatsAppApiError, WhatsAppValidationError, fromGraphResponse } from './whatsapp.errors';

const apiError = (
  kind: WhatsAppApiError['kind'],
  retryable: boolean,
  code?: number,
): WhatsAppApiError =>
  new WhatsAppApiError({ httpStatus: 400, kind, retryable, code, message: 'x' });

describe('outboundBackoffMs', () => {
  it('backs off exponentially for ordinary errors', () => {
    const low = (attempt: number): number => outboundBackoffMs(attempt, new Error('x'), () => 0);
    expect([1, 2, 3, 4].map(low)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('adds jitter (between 50% and 100% of the exponential delay)', () => {
    const delay = outboundBackoffMs(3, new Error('x'), () => 0.999);
    expect(delay).toBeGreaterThan(7_900);
    expect(delay).toBeLessThanOrEqual(8_000);
  });

  it('waits much longer after a rate limit (30 s, 60 s, ...) up to 5 minutes', () => {
    const rateLimit = apiError('rate_limit', true, 131056);
    expect(outboundBackoffMs(1, rateLimit)).toBe(30_000);
    expect(outboundBackoffMs(2, rateLimit)).toBe(60_000);
    expect(outboundBackoffMs(50, rateLimit)).toBe(300_000);
  });

  it('is capped at one minute for ordinary errors', () => {
    expect(outboundBackoffMs(30, new Error('x'), () => 0.999)).toBeLessThanOrEqual(60_000);
  });
});

describe('toUnrecoverable (which errors are worth retrying)', () => {
  it.each([
    [
      '131047 re-engagement (window closed)',
      fromGraphResponse(400, { error: { code: 131047, message: 'x' } }),
    ],
    ['131026 undeliverable', fromGraphResponse(400, { error: { code: 131026, message: 'x' } })],
    ['190 invalid token', fromGraphResponse(401, { error: { code: 190, message: 'x' } })],
    ['400 bad request', fromGraphResponse(400, { error: { code: 100, message: 'x' } })],
    ['404', fromGraphResponse(404, { error: { message: 'x' } })],
  ])('%s fails immediately without retries', (_name, error) => {
    expect(error.retryable).toBe(false);
    expect(toUnrecoverable(error)).toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    ['429 too many requests', fromGraphResponse(429, { error: { message: 'x' } })],
    ['130429 rate limit', fromGraphResponse(400, { error: { code: 130429, message: 'x' } })],
    ['131056 pair rate limit', fromGraphResponse(400, { error: { code: 131056, message: 'x' } })],
    ['500', fromGraphResponse(500, { error: { message: 'x' } })],
    ['503', fromGraphResponse(503, null)],
  ])('%s is retried', (_name, error) => {
    expect(error.retryable).toBe(true);
    expect(toUnrecoverable(error)).toBe(error);
  });

  it('retries a network error (the queue may retry; only the in-request client must not)', () => {
    const error = new WhatsAppApiError({
      httpStatus: 0,
      kind: 'network',
      retryable: true,
      message: 'x',
    });
    expect(toUnrecoverable(error)).toBe(error);
  });

  it('never retries our own validation / crypto errors', () => {
    expect(toUnrecoverable(new WhatsAppValidationError('bad'))).toBeInstanceOf(UnrecoverableError);
    expect(toUnrecoverable(new CryptoError('tampered'))).toBeInstanceOf(UnrecoverableError);
  });

  it('passes an existing UnrecoverableError through and retries unknown errors', () => {
    const unrecoverable = new UnrecoverableError('stop');
    expect(toUnrecoverable(unrecoverable)).toBe(unrecoverable);
    const unknown = new Error('db connection lost');
    expect(toUnrecoverable(unknown)).toBe(unknown);
  });

  it('uses a controlled message with no Meta text (it is stored in Redis)', () => {
    const error = fromGraphResponse(400, {
      error: { code: 131026, message: 'Recipient 9876543210 blocked us' },
    });
    const wrapped = toUnrecoverable(error);
    expect(wrapped.message).toBe('whatsapp undeliverable error (code 131026)');
    expect(wrapped.message).not.toContain('9876543210');
  });
});
