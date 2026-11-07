import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept caller-supplied ids only if they are short and log-safe. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Reuse a valid inbound `x-request-id` (e.g. from a load balancer) or mint a
 * UUID, and echo it on the response so clients can correlate.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  return requestId;
}

/** Read the request id previously set on the response (empty string if absent). */
export function getRequestId(res: ServerResponse): string {
  const value = res.getHeader(REQUEST_ID_HEADER);
  return typeof value === 'string' ? value : '';
}
