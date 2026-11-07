import { WINDOW_MS, WindowClosedError, isWithinWindow } from './window';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('isWithinWindow (24 h customer-service window)', () => {
  it('is open right after the user wrote', () => {
    expect(isWithinWindow(ago(0), NOW)).toBe(true);
    expect(isWithinWindow(ago(60_000), NOW)).toBe(true);
  });

  it('is open at 23 h 59 m 59.999 s', () => {
    expect(isWithinWindow(ago(WINDOW_MS - 1), NOW)).toBe(true);
  });

  it('is CLOSED at exactly 24 h (conservative boundary)', () => {
    expect(isWithinWindow(ago(WINDOW_MS), NOW)).toBe(false);
  });

  it('is closed after 24 h', () => {
    expect(isWithinWindow(ago(WINDOW_MS + 1), NOW)).toBe(false);
    expect(isWithinWindow(ago(3 * WINDOW_MS), NOW)).toBe(false);
  });

  it('is closed for a user who never wrote (null / undefined)', () => {
    expect(isWithinWindow(null, NOW)).toBe(false);
    expect(isWithinWindow(undefined, NOW)).toBe(false);
  });

  it('treats a timestamp slightly in the future (clock skew) as open', () => {
    expect(isWithinWindow(new Date(NOW.getTime() + 5_000), NOW)).toBe(true);
  });

  it('uses the current time by default', () => {
    expect(isWithinWindow(new Date())).toBe(true);
    expect(isWithinWindow(new Date(Date.now() - WINDOW_MS - 1_000))).toBe(false);
  });
});

describe('WindowClosedError', () => {
  it('has a clear name and message', () => {
    const error = new WindowClosedError();
    expect(error.name).toBe('WindowClosedError');
    expect(error.message).toMatch(/template/);
  });
});
