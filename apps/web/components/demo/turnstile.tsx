'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  execute: (id: string) => void;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export interface TurnstileHandle {
  /** Run a fresh challenge and resolve with a single-use token (undefined if it failed or timed out). */
  getToken: () => Promise<string | undefined>;
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * Cloudflare Turnstile in "execute" mode: invisible unless Cloudflare needs an interaction. Tokens are
 * single use and verified by the gateway, so each upload (and each re-run) asks for a fresh one.
 * Without a site key (local development) it renders nothing and getToken resolves undefined.
 */
export const Turnstile = forwardRef<
  TurnstileHandle,
  { siteKey: string | undefined; nonce?: string }
>(function Turnstile({ siteKey, nonce }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const pending = useRef<((token: string | undefined) => void) | null>(null);

  useEffect(() => {
    if (!siteKey) return;
    const mount = (): void => {
      if (!window.turnstile || !container.current || widgetId.current) return;
      widgetId.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        execution: 'execute',
        appearance: 'interaction-only',
        callback: (token: string) => pending.current?.(token),
        'error-callback': () => pending.current?.(undefined),
        'expired-callback': () => pending.current?.(undefined),
      });
    };
    if (window.turnstile) {
      mount();
    } else if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      if (nonce) script.nonce = nonce;
      script.onload = mount;
      document.head.appendChild(script);
    }
    return () => {
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, nonce]);

  useImperativeHandle(ref, () => ({
    getToken: () =>
      new Promise<string | undefined>((resolve) => {
        if (!siteKey || !window.turnstile || !widgetId.current) return resolve(undefined);
        const timer = setTimeout(() => resolve(undefined), 30_000);
        pending.current = (token) => {
          clearTimeout(timer);
          pending.current = null;
          resolve(token);
        };
        window.turnstile.reset(widgetId.current);
        window.turnstile.execute(widgetId.current);
      }),
  }));

  return siteKey ? <div ref={container} data-testid="turnstile" /> : null;
});
