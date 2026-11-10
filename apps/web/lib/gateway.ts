import { getServerSession } from 'next-auth';

import { signAdminToken } from '@/lib/admin-token';
import { buildAuthOptions, isAllowedAdmin } from '@/lib/auth';
import { serverEnv } from '@/lib/server-env';

export type GatewayResult<T> =
  { ok: true; data: T } | { ok: false; status: number; code: string; retryAfterS?: number };

/** The signed-in operator's e-mail, or null (no session, or not on the allowlist any more). */
export async function currentAdmin(): Promise<string | null> {
  const session = await getServerSession(buildAuthOptions());
  const email = session?.user?.email;
  return isAllowedAdmin(email, serverEnv().ADMIN_EMAILS) && email ? email.toLowerCase() : null;
}

/**
 * Call the gateway's `/admin/*` API as the signed-in operator: a fresh 5-minute JWT per call. The browser
 * never sees this token, the secret or the gateway URL (server-only module).
 */
export async function adminFetch<T>(
  email: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<GatewayResult<T>> {
  const env = serverEnv();
  if (!env.ADMIN_JWT_SECRET) return { ok: false, status: 503, code: 'admin_not_configured' };
  try {
    const response = await fetch(`${env.GATEWAY_URL.replace(/\/+$/, '')}/admin${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${signAdminToken(email, env.ADMIN_JWT_SECRET)}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (json as { error?: { code?: string; retry_after_s?: number } } | null)?.error;
      return {
        ok: false,
        status: response.status,
        code: error?.code ?? `http_${response.status}`,
        ...(error?.retry_after_s ? { retryAfterS: error.retry_after_s } : {}),
      };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 502, code: 'gateway_unavailable' };
  }
}

/**
 * CSRF guard for the admin POST routes (NextAuth protects its own endpoints): the request must come from
 * our own origin, as JSON. A cross-site form post carries a foreign Origin (or none) and is refused.
 */
export function sameOriginJson(request: Request): boolean {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return false;
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
