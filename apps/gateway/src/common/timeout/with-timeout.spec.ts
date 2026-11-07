import { TimeoutError, withTimeout } from './with-timeout';

describe('withTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves with the value when work finishes in time', async () => {
    await expect(withTimeout(() => Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('propagates the work error unchanged', async () => {
    const boom = new Error('boom');
    await expect(withTimeout(() => Promise.reject(boom), 1000)).rejects.toBe(boom);
  });

  it('rejects with TimeoutError and aborts the signal when work is too slow', async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    const pending = withTimeout((signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    }, 500);
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);

    await jest.advanceTimersByTimeAsync(500);

    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it('clears its timer when work finishes (no dangling handles)', async () => {
    jest.useFakeTimers();
    await withTimeout(() => Promise.resolve('done'), 1000);
    expect(jest.getTimerCount()).toBe(0);
  });
});
