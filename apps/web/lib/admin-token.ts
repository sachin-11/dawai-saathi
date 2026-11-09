import { createHmac } from 'node:crypto';

export const ADMIN_JWT_AUDIENCE = 'dawai-admin';
export const ADMIN_JWT_TTL_S = 300;

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * A short-lived HS256 token the Next.js server sends to the gateway on every admin call
 * (`sub` = the admin's e-mail, 5 minutes). The gateway verifies signature, expiry, audience and its own
 * allowlist again. Written with node:crypto on purpose: nothing to install, nothing to mis-configure
 * (the algorithm is fixed, so "alg: none" tricks do not exist on this side).
 */
export function signAdminToken(
  email: string,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: email.toLowerCase(),
      aud: ADMIN_JWT_AUDIENCE,
      iat: nowS,
      exp: nowS + ADMIN_JWT_TTL_S,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
