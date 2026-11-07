export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject if `work` does not settle within `timeoutMs`. The timer is always cleared, so it never
 * keeps the process (or a Jest worker) alive. `work` receives an AbortSignal that fires on timeout
 * so callers that support cancellation (AWS SDK, fetch) can stop the underlying request.
 */
export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
