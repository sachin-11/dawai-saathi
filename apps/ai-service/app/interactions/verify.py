"""Deterministic checks on interaction wording before a reply leaves the service (M11, §2.5).

The reply's interaction block is rendered from the findings by templates, so the strongest check is
simple: the exact block built from the findings must be in the reply, and no interaction sentence
(an effect phrase, a "nothing found" line, a severity marker) may appear that the findings do not
justify. A blocklist keeps "stop / band karo / mat lo" advice out for good.
"""

import re
from typing import Final

from app.interactions.effects import EFFECTS, FALLBACK
from app.interactions.render import MAJOR_MARKER, TEXT, render_block, shown_findings
from app.schemas.interactions import InteractionReport
from app.schemas.process import Language

# Phrases that tell a patient to stop, skip or avoid a medicine. We never say this (CLAUDE.md §1, §2.1).
_BLOCKLIST: Final = (
    re.compile(
        r"\b(?:stop(?:ping)?|discontinu\w*|quit|do not take|don'?t take|dont take|"
        r"do not use|avoid taking|no longer take|skip (?:your|the|this)|throw away)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:band\s*kar\w*|mat\s*(?:lo|lein|le|khao|khana|kijiye)|chhod\s*d\w*|"
        r"na\s*(?:lo|lein|khao)|nahi\s*(?:lena|lo|lein)\s*chahiye)\b",
        re.IGNORECASE,
    ),
    re.compile(r"बंद\s*कर|मत\s*(?:लो|लें|ले|खाओ|खाएँ)|छोड़\s*द|न\s+(?:लें|लो|खाएँ)|ना\s+(?:लें|लो)"),
)


# The unique start of each fixed sentence of the block: it may appear only when the block has it.
def _stems(language: Language) -> tuple[str, ...]:
    texts = TEXT[language]
    return (
        texts["unchecked"].split("{")[0][:24],
        texts["db_down"][:24],
        texts["none"][:24],
        texts["minor_only"][:24],
    )


_STEMS: Final[dict[Language, tuple[str, ...]]] = {
    language: _stems(language) for language in (Language.en, Language.hi)
}


def advice_to_stop(text: str) -> bool:
    """True when `text` tells the reader to stop, skip or avoid a medicine."""
    return any(pattern.search(text) for pattern in _BLOCKLIST)


def interaction_failures(
    report: InteractionReport | None,
    reply_text: str,
    language: Language,
    *,
    required: bool,
    whole_reply_blocklist: bool,
    query: bool = False,
) -> list[str]:
    """Failure codes (never text). `required`: the reply must carry a report (a typed question)."""
    if report is None:
        return ["interaction_report_missing"] if required else []
    failures: list[str] = []
    block = render_block(report, language, query=query)
    if block and block not in reply_text:
        failures.append("interaction_block_missing")

    # Nothing may be claimed that the findings do not justify.
    phrases = [en if language is Language.en else hi for en, hi in (*EFFECTS.values(), FALLBACK)]
    if any(phrase in reply_text and phrase not in block for phrase in phrases):
        failures.append("interaction_not_in_findings")
    if any(stem in reply_text and stem not in block for stem in _STEMS[language]):
        failures.append("interaction_statement_unjustified")

    # The severity marker appears exactly when a major finding is shown.
    major_shown = any(f.management_key == "major" for f in shown_findings(report, query=query))
    if MAJOR_MARKER[language] in reply_text and not major_shown:
        failures.append("severity_mismatch")

    if advice_to_stop(reply_text if whole_reply_blocklist else block):
        failures.append("stop_advice")
    return failures
