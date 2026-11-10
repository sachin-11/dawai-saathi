import { NextResponse } from 'next/server';
import { z } from 'zod';

import { REVIEW_LABELS } from '@/lib/admin-types';
import { adminFetch, currentAdmin, sameOriginJson } from '@/lib/gateway';

/**
 * The admin browser code calls these three routes only. Each one: signed-in operator + same-origin JSON,
 * then one fixed gateway call. There is deliberately no generic proxy.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uuid = z.uuid();
const bodies = {
  reveal: z.object({ id: uuid, reason: z.string().trim().min(10).max(500) }),
  resolve: z.object({ id: uuid, label: z.enum(REVIEW_LABELS) }),
  'dlq-retry': z.object({
    queue: z.enum(['inbound', 'outbound', 'reminders', 'user-deletion']),
    jobId: z.string().min(1).max(200),
  }),
} as const;

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function reply(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** The 60-second link never reaches the browser: the server fetches the picture and inlines it. */
async function inlineImage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const { action } = await context.params;
  if (!(action in bodies)) return reply(404, { error: { code: 'not_found' } });
  if (!sameOriginJson(request)) return reply(403, { error: { code: 'forbidden' } });
  const email = await currentAdmin();
  if (!email) return reply(401, { error: { code: 'unauthorized' } });

  const json: unknown = await request.json().catch(() => null);
  const schema = bodies[action as keyof typeof bodies];
  const parsed = schema.safeParse(json);
  if (!parsed.success) return reply(400, { error: { code: 'invalid_request' } });

  if (action === 'reveal') {
    const { id, reason } = parsed.data as z.infer<typeof bodies.reveal>;
    const result = await adminFetch<{ imageUrl: string } & Record<string, unknown>>(
      email,
      `/review-queue/${id}/reveal`,
      { method: 'POST', body: { reason } },
    );
    if (!result.ok) return reply(result.status, { error: { code: result.code } });
    const { imageUrl, ...rest } = result.data;
    return reply(200, { ...rest, imageDataUrl: await inlineImage(imageUrl) });
  }
  if (action === 'resolve') {
    const { id, label } = parsed.data as z.infer<typeof bodies.resolve>;
    const result = await adminFetch(email, `/review-queue/${id}/resolve`, {
      method: 'POST',
      body: { label },
    });
    return result.ok
      ? reply(200, result.data)
      : reply(result.status, { error: { code: result.code } });
  }
  const { queue, jobId } = parsed.data as z.infer<(typeof bodies)['dlq-retry']>;
  const result = await adminFetch(email, `/dlq/${queue}/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    body: {},
  });
  return result.ok
    ? reply(200, result.data)
    : reply(result.status, { error: { code: result.code } });
}
