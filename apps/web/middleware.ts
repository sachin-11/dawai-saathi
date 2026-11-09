import { type NextRequest, NextResponse } from 'next/server';

import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n';

/**
 * Two jobs:
 *  1. A strict Content-Security-Policy with a fresh nonce per request (Next.js puts the nonce on its own
 *     scripts when the policy is in the REQUEST headers).
 *  2. Locale routing without a prefix for Hindi: `/` -> internal `/hi`, `/en/...` as is, `/hi/...` -> `/...`.
 *     `/admin` and `/api` are not localised.
 */
export function buildCsp(nonce: string, dev: boolean, turnstile: boolean): string {
  const script = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(dev ? ["'unsafe-eval'"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    // React inline style attributes (charts, progress bars) need 'unsafe-inline' for styles only.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? ' ws: http://localhost:*' : ''}`,
    `frame-src ${turnstile ? 'https://challenges.cloudflare.com' : "'none'"}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const turnstile = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const csp = buildCsp(nonce, dev, turnstile);

  const { pathname } = request.nextUrl;
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  const finish = (response: NextResponse): NextResponse => {
    response.headers.set('Content-Security-Policy', csp);
    return response;
  };

  if (pathname.startsWith('/admin') || pathname.startsWith('/api')) {
    return finish(NextResponse.next({ request: { headers } }));
  }

  const first = pathname.split('/')[1] ?? '';
  if (first === DEFAULT_LOCALE) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice(`/${DEFAULT_LOCALE}`.length) || '/';
    return NextResponse.redirect(url, 308);
  }
  if (isLocale(first)) {
    headers.set('X-NEXT-INTL-LOCALE', first);
    return finish(NextResponse.next({ request: { headers } }));
  }
  headers.set('X-NEXT-INTL-LOCALE', DEFAULT_LOCALE);
  const url = request.nextUrl.clone();
  url.pathname = `/${DEFAULT_LOCALE}${pathname === '/' ? '' : pathname}`;
  return finish(NextResponse.rewrite(url, { request: { headers } }));
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|opengraph-image|icon|samples/|diagrams/).*)',
  ],
};
