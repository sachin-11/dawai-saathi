import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { getRequestId } from '../logger/request-id';

/** Consistent error body for every non-2xx response. */
export interface ErrorResponseBody {
  error: {
    status: number;
    code: string;
    message: string;
    details?: string[];
    /** Seconds until a rate-limited caller may retry (M16 demo / admin). */
    retry_after_s?: number;
    request_id: string;
  };
}

interface NormalisedError {
  status: number;
  message: string;
  details?: string[];
  /** A machine code chosen by the throwing code (M16: `rate_limited`, `budget_exhausted`, ...). */
  code?: string;
  retryAfterS?: number;
}

const MACHINE_CODE = /^[a-z][a-z0-9_]{0,40}$/;

/** Fixed messages for 4xx errors raised outside Nest (e.g. by the body parser). */
const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  413: 'Payload too large',
  415: 'Unsupported media type',
};

/**
 * Express middleware (body-parser) throws http-errors, not Nest HttpExceptions: an oversized body is
 * a 413, bad JSON a 400. Keep the status but NOT the original message, because it can echo a snippet
 * of the request body (PHI).
 */
function clientErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null || !('status' in exception)) {
    return undefined;
  }
  const status = exception.status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

function normalise(exception: unknown): NormalisedError {
  if (!(exception instanceof HttpException)) {
    const status = clientErrorStatus(exception);
    if (status !== undefined) {
      return { status, message: CLIENT_ERROR_MESSAGES[status] ?? 'Bad request' };
    }
    // Never leak internal error messages to callers.
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }

  const status = exception.getStatus();
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return { status, message: body };
  }

  const own = (body as { error?: { code?: unknown; retry_after_s?: unknown } }).error;
  if (own && typeof own.code === 'string' && MACHINE_CODE.test(own.code)) {
    return {
      status,
      message: exception.message,
      code: own.code,
      ...(typeof own.retry_after_s === 'number' ? { retryAfterS: own.retry_after_s } : {}),
    };
  }

  const raw = (body as { message?: unknown }).message;
  if (Array.isArray(raw)) {
    return { status, message: exception.message, details: raw.map(String) };
  }
  return { status, message: typeof raw === 'string' ? raw : exception.message };
}

function statusCode(status: number): string {
  const name = (HttpStatus as Record<number, string | undefined>)[status];
  return name ?? 'ERROR';
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(AllExceptionsFilter.name) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, message, details, code, retryAfterS } = normalise(exception);
    const requestId = getRequestId(res);

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error('non-error thrown');
      // Only stack FRAMES are logged: the first lines of `stack` repeat the message (driver errors
      // can contain row data), so keep just the "at ..." lines.
      const frames = (err.stack ?? '')
        .split('\n')
        .filter((line) => line.trimStart().startsWith('at '))
        .join('\n');
      this.logger.error({ err: { type: err.name, stack: frames }, status }, 'unhandled error');
    } else {
      this.logger.warn({ status }, 'request failed');
    }

    const body: ErrorResponseBody = {
      error: {
        status,
        code: code ?? statusCode(status),
        message,
        ...(details ? { details } : {}),
        ...(retryAfterS !== undefined ? { retry_after_s: retryAfterS } : {}),
        request_id: requestId,
      },
    };
    res.status(status).json(body);
  }
}
