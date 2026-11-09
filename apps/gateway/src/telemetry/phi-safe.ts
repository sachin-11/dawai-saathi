/**
 * PHI-safe span attributes (M15, CLAUDE.md §2.6). An attribute leaves the process only when its key
 * is on the allowlist (or starts with `dawai.`) AND its value is a short primitive that does not look
 * like a phone number or an e-mail. URLs are never exported (presigned S3 links carry signatures),
 * neither are DB statements, event messages or status descriptions.
 *
 * The same rules exist in the AI service (`app/observability/otel.py`); a test in each app pins them.
 */

export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.method',
  'http.request.method',
  'http.status_code',
  'http.response.status_code',
  'http.route',
  'http.flavor',
  'db.system',
  'db.operation',
  'error.type',
  'exception.type',
  'service.name',
]);
export const ALLOWED_PREFIX = 'dawai.';
export const EMERGENCY_ATTRIBUTE = 'dawai.emergency';
export const MAX_VALUE_LENGTH = 128;

const PHONE_LIKE = /(?:\+?\d[\s-]?){10,}/;
const EMAIL_LIKE = /\S+@\S+\.\S+/;
const NUMBER_ONLY = /^[+\d\s\-()]+$/;

export function valueIsSafe(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) return false;
  if (EMAIL_LIKE.test(value)) return false;
  // An id (hex trace id, uuid, wamid.xxx) is one token with letters: never a phone number. A phone
  // number is digits only, or hides in free text (a value with spaces).
  const looksLikeText = value.includes(' ') || NUMBER_ONLY.test(value);
  return !(looksLikeText && PHONE_LIKE.test(value));
}

export function scrubAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {};
  if (!attributes) return kept;
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_ATTRIBUTES.has(key) && !key.startsWith(ALLOWED_PREFIX)) continue;
    if (valueIsSafe(value)) kept[key] = value as string | number | boolean;
  }
  return kept;
}
