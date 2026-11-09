import { HttpException, type HttpStatus } from '@nestjs/common';

export type AdminErrorCode =
  | 'rate_limited'
  | 'not_found'
  | 'reason_required'
  | 'invalid_request'
  | 'already_reviewed'
  | 'unavailable';

/** Carries a machine `code` that the global exception filter passes through. */
export class AdminError extends HttpException {
  constructor(
    readonly code: AdminErrorCode,
    status: HttpStatus,
    retryAfterS?: number,
  ) {
    super(
      { error: { code, status, ...(retryAfterS ? { retry_after_s: retryAfterS } : {}) } },
      status,
    );
  }
}
