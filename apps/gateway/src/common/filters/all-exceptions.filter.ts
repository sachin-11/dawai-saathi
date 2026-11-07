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
    request_id: string;
  };
}

interface NormalisedError {
  status: number;
  message: string;
  details?: string[];
}

function normalise(exception: unknown): NormalisedError {
  if (!(exception instanceof HttpException)) {
    // Never leak internal error messages to callers.
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }

  const status = exception.getStatus();
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return { status, message: body };
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
    const { status, message, details } = normalise(exception);
    const requestId = getRequestId(res);

    if (status >= 500) {
      // Log the error type and stack only; messages may contain user data.
      const err = exception instanceof Error ? exception : new Error('non-error thrown');
      this.logger.error({ err: { type: err.name, stack: err.stack }, status }, 'unhandled error');
    } else {
      this.logger.warn({ status }, 'request failed');
    }

    const body: ErrorResponseBody = {
      error: {
        status,
        code: statusCode(status),
        message,
        ...(details ? { details } : {}),
        request_id: requestId,
      },
    };
    res.status(status).json(body);
  }
}
