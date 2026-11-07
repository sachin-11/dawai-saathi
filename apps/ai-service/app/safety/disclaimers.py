"""The disclaimer every medical answer ends with (CLAUDE.md §2.1).

M5 has no medical answers yet (help / "coming soon" are not medical), but the helper lives here so
the prescription and lab-report flows (M7, M12) cannot forget it.
"""

from typing import Final

from app.schemas.process import MAX_REPLY_CHARS, Language

DISCLAIMERS: Final[dict[Language, str]] = {
    Language.hi: "⚠️ मैं डॉक्टर नहीं हूँ। कृपया कुछ भी करने से पहले अपने डॉक्टर या फ़ार्मासिस्ट से पूछें।",
    Language.en: "⚠️ I am not a doctor. Please check with your doctor or pharmacist before acting on this.",
}

_SEPARATOR: Final = "\n\n"


def add_disclaimer(text: str, language: Language) -> str:
    """Append the disclaimer in the user's language. Idempotent, and never exceeds the WhatsApp limit.

    If the body is too long to leave room for the disclaimer, the BODY is shortened (with an
    ellipsis), never the disclaimer.
    """
    disclaimer = DISCLAIMERS[language]
    body = text.rstrip()
    if body.endswith(disclaimer):
        return body
    room = MAX_REPLY_CHARS - len(_SEPARATOR) - len(disclaimer)
    if len(body) > room:
        body = body[: room - 1].rstrip() + "…"
    return f"{body}{_SEPARATOR}{disclaimer}"
