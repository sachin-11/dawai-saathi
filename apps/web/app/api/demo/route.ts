import { NextResponse } from 'next/server';

import { serverEnv } from '@/lib/server-env';

/**
 * BFF for the playground: browser -> this route (server) -> gateway `/demo/*`.
 * The browser never sees the gateway URL, the demo key or any AI-service token. This handler only
 * validates the shape, forwards the visitor's address (for the gateway's per-IP limit) and passes the
 * gateway's answer through. Nothing is stored or logged here.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const SAMPLE_ID = /^[a-z0-9_]{1,40}$/;

function clientIp(request: Request): string {
  // Behind the load balancer (M17) the first entry is the real visitor. Locally there is none.
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'unknown';
}

function failure(code: string, status: number): NextResponse {
  return NextResponse.json(
    { error: { code } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

async function forward(path: string, init: RequestInit): Promise<NextResponse> {
  const env = serverEnv();
  if (!env.DEMO_API_KEY) return failure('gateway_unavailable', 503);
  try {
    const response = await fetch(`${env.GATEWAY_URL.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'X-Demo-Key': env.DEMO_API_KEY },
      signal: AbortSignal.timeout(90_000),
      cache: 'no-store',
    });
    const body: unknown = await response.json().catch(() => null);
    if (body === null) return failure('gateway_unavailable', 502);
    return NextResponse.json(body, {
      status: response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return failure('gateway_unavailable', 502);
  }
}

export async function GET(): Promise<NextResponse> {
  return forward('/demo/status', { method: 'GET' });
}

export async function POST(request: Request): Promise<NextResponse> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return failure('file_too_large', 413);
  if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    return failure('bad_request', 400);
  }

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    return failure('bad_request', 400);
  }

  const language = incoming.get('language');
  const sampleId = incoming.get('sample_id');
  const file = incoming.get('file');
  const token = incoming.get('turnstile_token');
  if (language !== 'hi' && language !== 'en') return failure('bad_request', 400);

  const outgoing = new FormData();
  outgoing.set('language', language);
  if (typeof sampleId === 'string' && sampleId !== '') {
    if (!SAMPLE_ID.test(sampleId) || file) return failure('bad_request', 400);
    outgoing.set('sample_id', sampleId);
  } else if (file instanceof File) {
    if (file.size > MAX_BODY_BYTES) return failure('file_too_large', 413);
    outgoing.set('file', file, 'upload');
    if (typeof token === 'string' && token.length <= 2048) outgoing.set('turnstile_token', token);
  } else {
    return failure('bad_request', 400);
  }

  return forward('/demo/process', {
    method: 'POST',
    headers: { 'X-Demo-Client-Ip': clientIp(request) },
    body: outgoing,
  });
}
