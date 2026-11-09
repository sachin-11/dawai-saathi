"""Deterministic checks of a lab reply before it leaves the service (M12, CLAUDE.md §2.1, §2.3, §2.5).

Codes only, never text. The reply is rendered by `lab_render` from the structured state, so these
checks prove two things independently of the renderer:
  * grounding   every number in the reply exists in the structured data (a printed value, range, date,
                count, trend value or a number inside a DB explanation / question that was used); every
                listed test is a test of the report
  * safety      no diagnosis or treatment wording (hi / en / Hinglish blocklist, applied to everything
                except our own fixed sentences), every critical value and every out-of-range result is
                mentioned (or counted), the critical line comes first, the disclaimer is there
"""

import re
import unicodedata

from app.labs.catalog import LabTest
from app.safety.disclaimers import DISCLAIMERS
from app.schemas.lab_report import LabReportExtraction, LabResult
from app.schemas.process import MAX_REPLY_CHARS, Language
from app.tools.lab_normalize import LabIndex
from app.tools.lab_render import (
    CRITICAL,
    MAX_OUTSIDE_LISTED,
    OUTSIDE,
    TEXTS,
    doctor_questions,
    explanation_of,
    format_date,
    format_number,
    pretty_unit,
    shown_name,
)

_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


# Sentences that are ours and fixed: they are removed before the blocklist scan (the disclaimer says
# "not a diagnosis", which must not trip the word "diagnos").
def _fixed_sentences() -> list[str]:
    fixed = [DISCLAIMERS[lang] for lang in Language]
    for lang in Language:
        t = TEXTS[lang]
        fixed += [t["info"], t["general"], t["others"], t["more"], t["all_more"], t["unread"]]
    return fixed


# Wording that would be a diagnosis, a verdict about a person, or advice on medicine / diet / dose.
# Matched case-insensitively on text with whitespace squashed.
BLOCKLIST: tuple[str, ...] = (
    # English
    "you have", "you are diabetic", "you are anaemic", "you are anemic", "you suffer",
    "suffering from", "diagnosed with", "is diagnosed", "disease confirmed", "confirms",
    "this means you", "which means you", "indicates that you", "suggests that you",
    "you should take", "you should stop", "you should avoid", "you must", "start taking",
    "stop taking", "take this medicine", "increase the dose", "reduce the dose", "your dose",
    "diet", "avoid eating", "should eat", "treatment", "cure",
    # Hinglish (Roman)
    "aapko diabetes", "aapko thyroid", "aapko anemia", "aapko bimari", "bimari hai",
    "thyroid ki bimari", "diabetes hai", "dawai lijiye", "dawa lijiye", "dawai len", "dawa len",
    "dawai band", "dawa band", "dose badhaye", "ilaaj", "parhez", "khana band",
    # Hindi (Devanagari)
    "आपको डायबिटीज", "आपको शुगर की बीमारी", "आपको थायराइड", "आपको एनीमिया", "बीमारी है",
    "की बीमारी", "आप बीमार", "दवा लें", "दवा लीजिए", "दवाई लें", "दवाई लीजिए", "दवा बंद",
    "दवाई बंद", "खुराक बढ़ा", "खुराक कम", "इलाज", "परहेज़", "डाइट", "पुष्टि हो",
)  # fmt: skip


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()


def numbers_in(text: str) -> set[str]:
    return set(_NUMBER.findall(text))


def blocklist_hits(text: str) -> list[str]:
    """Blocklisted phrases in `text` outside our own fixed sentences (returned as indexes, not text)."""
    scanned = text
    for sentence in _fixed_sentences():
        scanned = scanned.replace(sentence, " ")
    scanned = _squash(scanned)
    hits: list[str] = []
    for i, phrase in enumerate(BLOCKLIST):
        needle = _squash(phrase)
        if needle.isascii():  # whole words only: "cure" must not match "accurate"
            found = re.search(rf"(?<![a-z]){re.escape(needle)}(?![a-z])", scanned) is not None
        else:
            found = needle in scanned
        if found:
            hits.append(str(i))
    return hits


def allowed_numbers(
    extraction: LabReportExtraction,
    index: LabIndex | None,
    language: Language,
) -> set[str]:
    """Every number the reply may contain, derived from the same structured data the renderer used."""
    allowed: set[str] = set()
    n = len(extraction.results)
    for count in (n, *range(0, 4)):  # counts of tests and list numbers 1..3
        allowed.add(str(count))
    allowed.update(str(c) for c in range(0, n + 1))  # a count of normal / unknown / more tests
    if extraction.report_date.value is not None:
        allowed |= numbers_in(format_date(extraction.report_date.value))
    for r in extraction.results:
        texts = [
            r.value_raw.value or "",
            r.unit.value or "",
            r.range_text or "",
            r.category or "",
            shown_name(r),
            r.lab_ref_text.value or "",
            pretty_unit(r.unit_canonical),
        ]
        for text in texts:
            allowed |= numbers_in(text)
        if r.trend is not None:
            allowed |= numbers_in(format_number(r.trend.previous_value))
            allowed |= numbers_in(r.trend.previous_date.strftime("%b %Y"))
            allowed |= numbers_in(pretty_unit(r.trend.unit))
        if r.value_canonical is not None:
            allowed |= numbers_in(format_number(r.value_canonical))
        test = index.by_code.get(r.test_code) if index and r.test_code else None
        explanation = explanation_of(test, language)
        if explanation:
            allowed |= numbers_in(explanation)
    for question in doctor_questions(extraction, index, language):
        allowed |= numbers_in(question)
    return allowed


def lab_failures(
    text: str,
    extraction: LabReportExtraction,
    index: LabIndex | None,
    language: Language,
) -> list[str]:
    failures: list[str] = []
    if len(text) > MAX_REPLY_CHARS:
        failures.append("reply_too_long")
    if DISCLAIMERS[language] not in text:
        failures.append("disclaimer_missing")
    if blocklist_hits(text):
        failures.append("lab_diagnosis_wording")

    # ---- grounding: numbers
    allowed = allowed_numbers(extraction, index, language)
    if any(token not in allowed for token in numbers_in(text)):
        failures.append("lab_number_not_in_data")

    # ---- grounding: every bullet starts with a test name of this report
    names = {shown_name(r) for r in extraction.results}
    for line in text.splitlines():
        if line.startswith("• "):
            head = line[2:].split(":", 1)[0].strip()
            if head not in names:
                failures.append("lab_unknown_test_name")
                break

    # ---- completeness
    critical = [r for r in extraction.results if r.status in CRITICAL]
    outside = [r for r in extraction.results if r.status in OUTSIDE]
    if critical:
        first = text.lstrip().splitlines()[0] if text.strip() else ""
        if not first.startswith("🚨") or any(shown_name(r) not in first for r in critical):
            failures.append("critical_line_missing")
    listed_limit = max(MAX_OUTSIDE_LISTED, len(critical))
    ordered = sorted(outside, key=lambda r: r.status not in CRITICAL)
    for r in ordered[:listed_limit]:
        if f"• {shown_name(r)}:" not in text:
            failures.append("out_of_range_not_mentioned")
            break
    if len(ordered) > listed_limit:
        omitted = TEXTS[language]["more"].format(n=len(ordered) - listed_limit)
        if omitted not in text:
            failures.append("out_of_range_not_summarised")
    return list(dict.fromkeys(failures))


def result_name_set(results: list[LabResult]) -> set[str]:
    return {shown_name(r) for r in results}


__all__ = ["BLOCKLIST", "LabTest", "blocklist_hits", "lab_failures", "numbers_in"]
