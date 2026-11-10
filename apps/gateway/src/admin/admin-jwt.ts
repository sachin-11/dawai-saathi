import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_JWT_AUDIENCE = 'dawai-admin';
/** The Next.js server mints 5-minute tokens; anything claiming a longer life is refused. */
export const ADMIN_JWT_MAX_LIFETIME_S = 600;
const CLOCK_SKEW_S = 30;

export type AdminJwtFailure =
  | 'malformed'
  | 'bad_algorithm'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_audience'
  | 'too_long_lived'
  | 'not_allowed';

export type AdminJwtResult = { ok: true; email: string } | { ok: false; reason: AdminJwtFailure };

const fail = (reason: AdminJwtFailure): AdminJwtResult => ({ ok: false, reason });

function decode(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8'));
  } catch {
    return undefined;
  }
}

/**
 * Verify an HS256 admin JWT (defence in depth: the Next.js server already checked the session). Checks,
 * in this order: shape, algorithm (exactly HS256, so `none` and RS/HS confusion cannot work), signature
 * (constant time), expiry, not-before, audience, lifetime cap, and finally the allowlist of operator
 * e-mails. Nothing is read from the token before its signature is valid except the header's `alg`.
 */
export function verifyAdminJwt(
  token: string,
  secret: string,
  allowlist: readonly string[],
  nowS: number = Math.floor(Date.now() / 1000),
): AdminJwtResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return fail('malformed');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decode(headerPart) as { alg?: unknown } | undefined;
  if (!header || header.alg !== 'HS256') return fail('bad_algorithm');

  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  const provided = Buffer.from(signaturePart, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return fail('bad_signature');
  }

  const payload = decode(payloadPart) as
    { sub?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; nbf?: unknown } | undefined;
  if (!payload || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') {
    return fail('malformed');
  }
  if (payload.exp + CLOCK_SKEW_S < nowS) return fail('expired');
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS)
    return fail('not_yet_valid');
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > nowS)
    return fail('not_yet_valid');
  if (payload.aud !== ADMIN_JWT_AUDIENCE) return fail('bad_audience');
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : nowS;
  if (payload.exp - issuedAt > ADMIN_JWT_MAX_LIFETIME_S) return fail('too_long_lived');

  const email = payload.sub.trim().toLowerCase();
  if (!allowlist.includes(email)) return fail('not_allowed');
  return { ok: true, email };
}
