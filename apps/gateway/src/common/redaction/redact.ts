/**
 * Gateway-side safety net for text that is stored in `messages.body_redacted`
 * (CLAUDE.md §2.6, §10). The AI service later runs full Presidio redaction (M6); this makes sure
 * obvious identifiers never reach our database or logs in the meantime.
 *
 * Replaces, in this order (order matters, more specific first):
 *   emails -> [REDACTED_EMAIL]
 *   Indian mobile numbers (+91 / 91 / 0 prefix optional) -> [REDACTED_PHONE]
 *   12-digit Aadhaar-like numbers (optionally grouped 4-4-4) -> [REDACTED_AADHAAR]
 *   6-digit PIN codes -> [REDACTED_PIN]
 *
 * Known trade-off: any standalone 6-digit number (e.g. "platelets 150000") is treated as a PIN code.
 * Over-redacting is the safe direction for a safety net.
 */
const RULES: readonly { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    replacement: '[REDACTED_EMAIL]',
  },
  {
    // optional country code / trunk 0, then 10 digits starting 6-9, optionally split 5+5
    pattern: /(?<![\w])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g,
    replacement: '[REDACTED_PHONE]',
  },
  {
    pattern: /(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
    replacement: '[REDACTED_AADHAAR]',
  },
  {
    pattern: /(?<!\d)[1-9]\d{5}(?!\d)/g,
    replacement: '[REDACTED_PIN]',
  },
];

export function redactText(text: string): string {
  return RULES.reduce(
    (result, { pattern, replacement }) => result.replace(pattern, replacement),
    text,
  );
}
