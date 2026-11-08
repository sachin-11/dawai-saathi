"""Deterministic wording for interaction findings (M11, CLAUDE.md §2.1, §2.5).

Every sentence here is a fixed template filled with names and salts from the findings and with an
effect phrase from `effects.py`. No model writes any of it, and no sentence tells the user to stop,
skip or change a medicine: it says what is known and sends them to their doctor or pharmacist.

Absence of a row is NOT safety: the "nothing found" line says exactly that, and a database problem
or a medicine that could not be looked up is said out loud instead of being passed over.
"""

from collections.abc import Sequence
from typing import Final

from app.interactions.effects import effect_phrase
from app.interactions.repository import InteractionRow
from app.schemas.interactions import InteractionFinding, InteractionReport, UncheckedMedicine
from app.schemas.process import Language

MAX_SHOWN = 3  # findings in the main reply; the rest is behind the details button / CHECK

# A safe Hindi line used until a human has reviewed the specific Hindi management text of a row.
GENERIC_HI: Final = "इन दवाइयों को साथ लेने से पहले अपने डॉक्टर या फ़ार्मासिस्ट से ज़रूर बात करें।"
GENERIC_EN: Final = "Please ask your doctor or pharmacist before taking these together."

_AND: Final = {Language.en: " and ", Language.hi: " और "}
_THIS: Final = {Language.en: "this medicine", Language.hi: "यह दवाई"}

TEXT: Final[dict[Language, dict[str, str]]] = {
    Language.en: {
        "major": (
            "Important: Taking {names} together {effect}. "
            "Please talk to your doctor today before taking them."
        ),
        "moderate": (
            "{names}: taking them together {effect}. "
            "Some caution is needed. Please ask your doctor or pharmacist."
        ),
        "minor": "{names}: taking them together {effect}. You may mention it to your doctor.",
        "duplicate": (
            "{names} both contain {salt}. "
            "Please ask your doctor or pharmacist before taking them together."
        ),
        "duplicate_overdose": (
            "{names} both contain {salt}. Taking both can mean too much of the same medicine. "
            "Please ask your doctor or pharmacist before taking them together."
        ),
        "none": (
            "📌 I found no known interaction between these medicines in my database. "
            "That does not mean there is none, so please tell your doctor or pharmacist about "
            "all your medicines."
        ),
        "minor_only": (
            "📌 I found only minor notes for these medicines. Tap the details button to see them."
        ),
        "unchecked": (
            "📌 I could not check these medicines in my database: {names}. "
            "That does not mean they are safe. Please ask your pharmacist."
        ),
        "db_down": (
            "📌 I could not check for interactions right now. "
            "Please tell your doctor or pharmacist about all your medicines."
        ),
        "more": "🔹 {count} more note(s). Send CHECK or tap the details button to see all.",
    },
    Language.hi: {
        "major": ("ज़रूरी: {names} साथ लेने से {effect}। दवा लेने से पहले आज ही अपने डॉक्टर से बात करें।"),
        "moderate": (
            "{names}: साथ लेने से {effect}। थोड़ी सावधानी चाहिए। अपने डॉक्टर या फ़ार्मासिस्ट से पूछें।"
        ),
        "minor": "{names}: साथ लेने से {effect}। डॉक्टर को बता सकते हैं।",
        "duplicate": (
            "{names} दोनों में एक ही दवाई ({salt}) है। साथ लेने से पहले अपने डॉक्टर या फ़ार्मासिस्ट से पूछें।"
        ),
        "duplicate_overdose": (
            "{names} दोनों में एक ही दवाई ({salt}) है। दोनों लेने से एक ही दवाई "
            "ज़रूरत से ज़्यादा हो सकती है। साथ लेने से पहले अपने डॉक्टर या फ़ार्मासिस्ट से पूछें।"
        ),
        "none": (
            "📌 हमारे डेटाबेस में इन दवाइयों के बीच कोई जानी-मानी इंटरैक्शन नहीं मिली। "
            "इसका मतलब यह नहीं कि कोई खतरा नहीं है, इसलिए अपने डॉक्टर या फ़ार्मासिस्ट "
            "को अपनी सभी दवाइयाँ ज़रूर बताएँ।"
        ),
        "minor_only": ("📌 इन दवाइयों के लिए सिर्फ़ छोटे नोट मिले। देखने के लिए डिटेल्स बटन दबाएँ।"),
        "unchecked": (
            "📌 इन दवाइयों की जाँच हमारे डेटाबेस में नहीं हो पाई: {names}। "
            "इसका मतलब यह नहीं कि ये सुरक्षित हैं। कृपया फ़ार्मासिस्ट से पूछें।"
        ),
        "db_down": (
            "📌 अभी इंटरैक्शन की जाँच नहीं हो पाई। अपने डॉक्टर या फ़ार्मासिस्ट को अपनी सभी दवाइयाँ ज़रूर बताएँ।"
        ),
        "more": "🔹 {count} और नोट। सभी देखने के लिए CHECK भेजें या डिटेल्स बटन दबाएँ।",
    },
}

# The prefix of each kind of finding in the main reply, and the words that mark a MAJOR finding;
# the verifier checks that they appear exactly when a major finding is shown.
PREFIX: Final = {
    "major": "⚠️ ",
    "moderate": "• ",
    "minor": "• ",
    "duplicate": "⚠️ ",
    "duplicate_overdose": "⚠️ ",
}
MAJOR_MARKER: Final = {Language.en: "Important:", Language.hi: "ज़रूरी:"}


def _names(labels: Sequence[str], language: Language) -> str:
    shown = [label for label in labels if label] or [_THIS[language]]
    if len(shown) <= 2:
        return _AND[language].join(shown)
    return ", ".join(shown[:-1]) + _AND[language] + shown[-1]


def render_finding(
    finding: InteractionFinding, language: Language, *, prefix: str | None = None
) -> str:
    text = TEXT[language]
    names = _names(finding.labels, language)
    lead = PREFIX[finding.management_key] if prefix is None else prefix
    if finding.type == "duplicate_ingredient":
        return lead + text[finding.management_key].format(names=names, salt=finding.salt_a)
    return lead + text[finding.management_key].format(
        names=names, effect=effect_phrase(finding.effect_code, language.value)
    )


MAX_SHOWN_QUERY = 6  # a typed question has no details button: it shows everything it found


def shown_findings(report: InteractionReport, *, query: bool = False) -> list[InteractionFinding]:
    """What the reply announces. A prescription reply: major, duplicate and moderate findings, at
    most MAX_SHOWN (the rest is behind the details button). A typed question: everything, minor
    included, because there is no details view for it."""
    if query:
        return list(report.findings)[:MAX_SHOWN_QUERY]
    return [f for f in report.findings if f.management_key != "minor"][:MAX_SHOWN]


def hidden_count(report: InteractionReport, *, query: bool = False) -> int:
    return len(report.findings) - len(shown_findings(report, query=query))


def unchecked_line(unchecked: Sequence[UncheckedMedicine], language: Language) -> str | None:
    labels = [u.label for u in unchecked if u.label]
    if not labels:
        return None
    return TEXT[language]["unchecked"].format(names=", ".join(labels[:5]))


def render_block(report: InteractionReport, language: Language, *, query: bool = False) -> str:
    """The interaction part of a reply (empty when there is nothing honest to say).

    Never says "safe". With fewer than two checkable medicines no pair was checked, so no
    "nothing found" line is shown either.
    """
    text = TEXT[language]
    parts: list[str] = []
    if not report.database_ok:
        parts.append(text["db_down"])
    else:
        shown = shown_findings(report, query=query)
        parts.extend(render_finding(f, language) for f in shown)
        hidden = hidden_count(report, query=query)
        if shown and hidden and not query:
            parts.append(text["more"].format(count=hidden))
        elif not shown and report.findings:
            parts.append(text["minor_only"])
        elif not report.findings and report.checked_count >= 2:
            parts.append(text["none"])
    note = unchecked_line(report.unchecked, language)
    if note:
        parts.append(note)
    return "\n\n".join(parts)


# ---------------------------------------------------------------- the details view


def _severity_icon(finding: InteractionFinding) -> str:
    return {"major": "🔴", "moderate": "🟠", "minor": "🟡"}.get(finding.severity or "", "🟠")


def _management(row: InteractionRow | None, language: Language) -> str:
    if row is None:
        return GENERIC_HI if language is Language.hi else GENERIC_EN
    if language is Language.hi:
        return row.management_hi if row.hi_reviewed and row.management_hi else GENERIC_HI
    return row.management_en or GENERIC_EN


def render_details(
    findings: Sequence[InteractionFinding],
    rows: dict[tuple[str, str], InteractionRow],
    report: InteractionReport,
    language: Language,
) -> str:
    """The full list (minor too) with the management line and the source of every row."""
    title = "📋 पूरी जानकारी" if language is Language.hi else "📋 Full details"
    blocks: list[str] = [title]
    sources: list[str] = []
    for number, finding in enumerate(findings, start=1):
        row = rows.get((finding.salt_a, finding.salt_b))
        if finding.type == "interaction":
            body = render_finding(finding, language, prefix=f"{_severity_icon(finding)} ")
            body = f"{number}. {body}\n   {_management(row, language)}"
            if row is not None and row.source and row.source not in sources:
                sources.append(row.source)
        else:
            body = f"{number}. " + render_finding(finding, language)
        blocks.append(body)
    if not findings:
        blocks.append(TEXT[language]["none"] if report.database_ok else TEXT[language]["db_down"])
    note = unchecked_line(report.unchecked, language)
    if note:
        blocks.append(note)
    if sources:
        label = "स्रोत" if language is Language.hi else "Source"
        blocks.append(f"{label}: " + "; ".join(sources))
    return "\n\n".join(blocks)


# ---------------------------------------------------------------- a typed question

_QUERY_HEADER: Final = {
    Language.en: "💊 You asked about: {names}.",
    Language.hi: "💊 आपने इनके बारे में पूछा: {names}।",
}


def render_query_reply(
    names: Sequence[str], report: InteractionReport, language: Language
) -> str | None:
    """The answer to "can I take X and Y together?": the names as the user wrote them, then the block.

    None when there is nothing honest to say (then the caller uses the `interaction.unavailable`
    template) — never an empty or a reassuring text.
    """
    block = render_block(report, language, query=True)
    if not block:
        return None
    header = _QUERY_HEADER[language].format(names=_names(list(names), language))
    return f"{header}\n\n{block}"
