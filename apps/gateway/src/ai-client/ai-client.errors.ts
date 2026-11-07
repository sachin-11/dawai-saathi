export type AiServiceErrorKind =
  'timeout' | 'connection' | 'unauthorized' | 'server' | 'client' | 'invalid_response';

/**
 * Typed failure of a call to the AI service. The message is generic: the AI service's own error
 * body is never forwarded (it could echo user data); `code` is its stable machine-readable code
 * (e.g. LLM_UNAVAILABLE, PROCESS_TIMEOUT).
 */
export class AiServiceError extends Error {
  constructor(
    readonly kind: AiServiceErrorKind,
    readonly status: number | undefined,
    readonly code: string | undefined,
  ) {
    super(`AI service call failed: ${kind}${status !== undefined ? ` (${status})` : ''}`);
    this.name = 'AiServiceError';
  }
}
