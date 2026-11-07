import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_FORMAT = /^sha256=([0-9a-fA-F]{64})$/;

/** `sha256=<hex HMAC-SHA256 of the raw body>`: the value Meta puts in X-Hub-Signature-256. */
export function signBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/**
 * Verify Meta's signature over the EXACT bytes that were received. Re-serialising the parsed JSON
 * would change whitespace/key order/unicode escapes and break the HMAC, which is why the raw body
 * is required. Comparison is constant-time.
 */
export function verifySignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!rawBody || !header) {
    return false;
  }
  const match = SIGNATURE_FORMAT.exec(header);
  if (!match?.[1]) {
    return false;
  }
  const received = Buffer.from(match[1], 'hex'); // always 32 bytes thanks to the regex
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(received, expected);
}
