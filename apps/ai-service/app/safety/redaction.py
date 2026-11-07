"""Basic PII redaction (regex). The full Presidio-based redaction with Indian recognisers arrives in M6.

Used wherever text could leave the process or reach a log: Langfuse traces and debug logging
(CLAUDE.md §2.6, §10). Mirrors the gateway's safety net (`apps/gateway/src/common/redaction`):
emails, Indian mobile numbers, Aadhaar-like 12-digit numbers and 6-digit PIN codes.

Trade-off: any standalone 6-digit number (e.g. "platelets 150000") is treated as a PIN code.
Over-redacting is the safe direction here.
"""

import re
from typing import Any, Final

_RULES: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (
        re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"),
        "[REDACTED_EMAIL]",
    ),
    # optional country code / trunk 0, then 10 digits starting 6-9, optionally split 5+5
    (re.compile(r"(?<!\w)(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)"), "[REDACTED_PHONE]"),
    (re.compile(r"(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)"), "[REDACTED_AADHAAR]"),
    (re.compile(r"(?<!\d)[1-9]\d{5}(?!\d)"), "[REDACTED_PIN]"),
)


def redact_text(text: str) -> str:
    """Replace emails, phone numbers, Aadhaar-like numbers and PIN codes with placeholders."""
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    return text


def redact_value(value: Any, *, _depth: int = 0) -> Any:
    """Redact every string inside nested dicts/lists/tuples (used before sending data to Langfuse)."""
    if _depth > 8:
        return "[REDACTED_DEEP]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {key: redact_value(item, _depth=_depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_value(item, _depth=_depth + 1) for item in value]
    return value
