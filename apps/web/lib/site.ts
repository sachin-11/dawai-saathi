import qr from '@/lib/generated/qr.json';

/** Public (non-secret) site configuration. NEXT_PUBLIC_* values are inlined at build time. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001').replace(
  /\/+$/,
  '',
);
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'privacy@dawaisaathi.example';
export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL ?? 'https://github.com';
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || undefined;

/** `https://wa.me/<number>?text=Hi` (digits only). The QR code is generated from the same URL at build time. */
export const WHATSAPP_URL = qr.url;
export const WHATSAPP_QR_SVG = qr.svg;

/** The date the privacy policy and terms were last edited. Change it whenever their text changes. */
export const LEGAL_UPDATED = '2026-11-09';
