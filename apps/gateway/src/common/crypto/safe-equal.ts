import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for secrets (verify tokens, signatures).
 * Both sides are hashed first so the buffers always have equal length: `timingSafeEqual` throws on
 * different lengths, and an early length check would itself leak the secret's length.
 */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
