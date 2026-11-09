"""The lab report reply (M12), rendered from structured data ONLY.

No model writes a word of it: names, values, units and ranges are copied from the extraction, the
explanations and doctor questions come from `lab_tests`, everything else is a fixed sentence below. That
is stricter than "an LLM verbalises the payload" and it is why the verifier (`lab_verify.py`) can prove
the text only contains what the data contains (CLAUDE.md §2.5).

  render_lab_reply     the main reply (critical line first, counts, out-of-range list, trends, questions)
  render_all_tests     the "see all tests" follow-up, grouped by section
  render_lab_question  "TSH 6.2 matlab kya?": explanation + general range, never an interpretation
"""

import re
from dataclasses import dataclass
from datetime import date
from typing import Literal

from app.labs.catalog import LabTest
from app.safety.disclaimers import DISCLAIMERS
from app.schemas.lab_report import LabReportExtraction, LabResult
from app.schemas.process import MAX_REPLY_CHARS, Language
from app.tools.lab_compare import range_label, select_fallback
from app.tools.lab_normalize import LabIndex

Mode = Literal["full", "minimal"]

MAX_OUTSIDE_LISTED = 12
MAX_QUESTIONS = 3
MAX_NAME_CHARS = 60
OUTSIDE = ("high", "low", "critical_high", "critical_low", "qualitative_abnormal")
CRITICAL = ("critical_high", "critical_low")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

_PRETTY_UNITS = {
    "mg/dl": "mg/dL", "g/dl": "g/dL", "ug/dl": "µg/dL", "ng/ml": "ng/mL", "pg/ml": "pg/mL",
    "ng/dl": "ng/dL", "miu/l": "mIU/L", "mmol/l": "mmol/L", "u/l": "U/L", "mg/l": "mg/L",
    "10^3/ul": "10³/µL", "10^6/ul": "10⁶/µL", "fl": "fL", "ml/min/1.73m2": "mL/min/1.73m²",
}  # fmt: skip

TEXTS: dict[Language, dict[str, str]] = {
    Language.en: {
        "header": "🧪 Your report ({date}) — {n} tests:",
        "header_nodate": "🧪 Your report — {n} tests:",
        "critical": "🚨 Some values are very high or very low ({names}). Please contact your doctor today.",
        "critical_unconfirmed": "🚨 Some values may be very high or very low ({names}), but I could not read them clearly. Please contact your doctor today and confirm them with the lab.",
        "normal": "✅ {n} within the normal range",
        "outside": "⚠️ Outside the range:",
        "close": "🟡 Close to the edge of the range:",
        "trend": "📈 Since your last report:",
        "confirm": "🔎 I could not read these clearly. Please confirm them with the lab or your doctor:",
        "others": "ℹ️ {n} more tests on the report are not explained here. Tap “See all tests”.",
        "more": "… and {n} more outside the range. Tap “See all tests”.",
        "unread": "… and {n} more lines that I could not read at all.",
        "questions": "❓ You can ask your doctor:",
        "info": "ℹ️ This is information only, not a diagnosis. Please show the report to your doctor.",
        "general": "(Your age or sex was not on the report, so a general adult range was used where the lab's own range was not available.)",
        "high": "above the range",
        "low": "below the range",
        "critical_high": "very high",
        "critical_low": "very low",
        "qualitative_abnormal": "not in the normal state",
        "lab_range": "lab range {r}",
        "general_range": "general range {r}",
        "flag_high": "marked high by the lab",
        "flag_low": "marked low by the lab",
        "flag_abnormal": "marked abnormal by the lab",
        "now_in": "now within the range",
        "now_out": "now outside the range",
        "all_title": "🧪 All tests on your report{date}:",
        "all_more": "… and {n} more tests are not shown here.",
        "ok": "within the range",
        "close_short": "close to the edge",
        "unclear": "please confirm with the lab",
        "other_section": "Other tests",
        "q_title": "🧪 {name}",
        "q_range": "A typical adult range is {r} {u}. Ranges differ from lab to lab.",
        "q_value": "You mentioned {v}. Please compare it with the range printed on YOUR report; I cannot say what it means for you.",
        "q_ask": "Your doctor can tell you what your value means for you.",
        "q_unknown": "I do not have information about this test yet. Please ask your doctor or the lab.",
        "q_none": "Please tell me which test you want to know about, for example “What is HbA1c?”, or send a clear photo of the report.",
        "q_unavailable": "I cannot look up the lab tests right now. Please try again in a little while.",
        "lab_unreadable": "I could not read this report clearly, so I will not guess. Please send a clear photo of every page, or show the report to your doctor.",
        "no_results": "I could not find any test results on this file. Please send a clear photo of the page with the results.",
    },
    Language.hi: {
        "header": "🧪 आपकी रिपोर्ट ({date}) — {n} टेस्ट:",
        "header_nodate": "🧪 आपकी रिपोर्ट — {n} टेस्ट:",
        "critical": "🚨 कुछ वैल्यू बहुत ज़्यादा या बहुत कम हैं ({names})। कृपया आज ही अपने डॉक्टर से संपर्क करें।",
        "critical_unconfirmed": "🚨 कुछ वैल्यू बहुत ज़्यादा या बहुत कम हो सकती हैं ({names}), पर मैं उन्हें साफ़ नहीं पढ़ पाया। कृपया आज ही अपने डॉक्टर से संपर्क करें और लैब से पक्का करें।",
        "normal": "✅ {n} टेस्ट सामान्य रेंज में",
        "outside": "⚠️ रेंज से बाहर:",
        "close": "🟡 रेंज की सीमा के पास:",
        "trend": "📈 पिछली रिपोर्ट से:",
        "confirm": "🔎 इन्हें मैं साफ़ नहीं पढ़ पाया। कृपया लैब या डॉक्टर से पक्का करें:",
        "others": "ℹ️ रिपोर्ट के {n} और टेस्ट यहाँ समझाए नहीं गए हैं। “सब टेस्ट देखें” दबाएँ।",
        "more": "… और {n} टेस्ट रेंज से बाहर हैं। “सब टेस्ट देखें” दबाएँ।",
        "unread": "… और {n} लाइनें जिन्हें मैं बिल्कुल पढ़ नहीं पाया।",
        "questions": "❓ डॉक्टर से पूछ सकते हैं:",
        "info": "ℹ️ यह सिर्फ़ जानकारी है, निदान नहीं। रिपोर्ट डॉक्टर को ज़रूर दिखाएँ।",
        "general": "(आपकी उम्र या लिंग रिपोर्ट में नहीं मिला, इसलिए जहाँ लैब की अपनी रेंज नहीं थी वहाँ सामान्य वयस्क रेंज से तुलना की।)",
        "high": "रेंज से ज़्यादा",
        "low": "रेंज से कम",
        "critical_high": "बहुत ज़्यादा",
        "critical_low": "बहुत कम",
        "qualitative_abnormal": "सामान्य स्थिति में नहीं",
        "lab_range": "लैब रेंज {r}",
        "general_range": "सामान्य रेंज {r}",
        "flag_high": "लैब ने ज़्यादा लिखा है",
        "flag_low": "लैब ने कम लिखा है",
        "flag_abnormal": "लैब ने असामान्य लिखा है",
        "now_in": "अब रेंज के अंदर है",
        "now_out": "अब रेंज से बाहर है",
        "all_title": "🧪 आपकी रिपोर्ट के सभी टेस्ट{date}:",
        "all_more": "… और {n} टेस्ट यहाँ नहीं दिखाए गए।",
        "ok": "रेंज में",
        "close_short": "सीमा के पास",
        "unclear": "लैब से पक्का करें",
        "other_section": "अन्य टेस्ट",
        "q_title": "🧪 {name}",
        "q_range": "वयस्कों के लिए आम रेंज {r} {u} होती है। रेंज हर लैब में थोड़ी अलग हो सकती है।",
        "q_value": "आपने {v} बताया। कृपया इसे अपनी रिपोर्ट में छपी रेंज से मिलाएँ; मैं यह नहीं बता सकता कि इसका आपके लिए क्या मतलब है।",
        "q_ask": "आपके लिए इस वैल्यू का क्या मतलब है, यह आपका डॉक्टर बता सकता है।",
        "q_unknown": "इस टेस्ट की जानकारी अभी मेरे पास नहीं है। कृपया अपने डॉक्टर या लैब से पूछें।",
        "q_none": "कृपया बताएँ किस टेस्ट के बारे में जानना है, जैसे “HbA1c क्या है?”, या रिपोर्ट की साफ़ फ़ोटो भेजें।",
        "q_unavailable": "अभी मैं लैब टेस्ट की जानकारी नहीं देख पा रहा। कृपया थोड़ी देर बाद फिर कोशिश करें।",
        "lab_unreadable": "मैं यह रिपोर्ट साफ़ नहीं पढ़ पाया, इसलिए अंदाज़ा नहीं लगाऊँगा। कृपया हर पन्ने की साफ़ फ़ोटो भेजें या रिपोर्ट अपने डॉक्टर को दिखाएँ।",
        "no_results": "इस फ़ाइल में मुझे कोई टेस्ट रिज़ल्ट नहीं मिला। कृपया रिज़ल्ट वाले पन्ने की साफ़ फ़ोटो भेजें।",
    },
}

BUTTON_TITLES: dict[Language, dict[str, str]] = {
    Language.en: {"all": "See all tests", "wrong": "Something wrong"},
    Language.hi: {"all": "सब टेस्ट देखें", "wrong": "कुछ गलत है"},
}


def pretty_unit(unit: str | None) -> str:
    if not unit:
        return ""
    return _PRETTY_UNITS.get(unit, unit)


def format_number(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def format_date(value: date) -> str:
    return f"{value.day} {_MONTHS[value.month - 1]} {value.year}"


def clean_name(raw: str | None) -> str:
    return re.sub(r"\s+", " ", raw or "").strip()[:MAX_NAME_CHARS]


def shown_name(result: LabResult) -> str:
    return clean_name(result.raw_test_name.value)


def shown_value(result: LabResult) -> str:
    value = (result.value_raw.value or "").strip()
    unit = (result.unit.value or "").strip()
    return f"{value} {unit}".strip()


def report_date_of(extraction: LabReportExtraction, minimum: float) -> date | None:
    field = extraction.report_date
    return field.value if field.value is not None and field.confidence >= minimum else None


# ------------------------------------------------------------------ explanation and wording


def _test_of(result: LabResult, index: LabIndex | None) -> LabTest | None:
    if index is None or result.test_code is None:
        return None
    return index.by_code.get(result.test_code)


def explanation_of(test: LabTest | None, language: Language) -> str | None:
    """English always; Hindi only after a human reviewed it (else the line is simply left out)."""
    if test is None:
        return None
    if language is Language.en:
        return test.explanation_en or None
    return test.explanation_hi if test.hi_reviewed and test.explanation_hi else None


def _basis_text(result: LabResult, language: Language) -> str:
    t = TEXTS[language]
    if result.range_basis == "printed" and result.range_text:
        return t["lab_range"].format(r=result.range_text)
    if result.range_basis == "fallback" and result.range_text:
        return t["general_range"].format(r=result.range_text)
    if result.range_basis == "flag":
        key = {"high": "flag_high", "low": "flag_low"}.get(result.status, "flag_abnormal")
        return t[key]
    return ""


def result_line(result: LabResult, test: LabTest | None, language: Language, mode: Mode) -> str:
    """'• HbA1c: 7.2 % (lab range < 5.7) — above the range — <explanation>'."""
    t = TEXTS[language]
    parts = [f"• {shown_name(result)}: {shown_value(result)}"]
    basis = _basis_text(result, language)
    if result.category:
        basis = f"{basis}, {result.category}" if basis else result.category
    if basis:
        parts[0] += f" ({basis})"
    if result.status in t:
        parts.append(t[result.status])
    if mode == "full":
        explanation = explanation_of(test, language)
        if explanation:
            parts.append(explanation)
    return " — ".join(parts)


def trend_lines(extraction: LabReportExtraction, language: Language) -> list[str]:
    t = TEXTS[language]
    notable = [r for r in extraction.results if r.trend is not None and r.trend.direction != "same"]

    def size(r: LabResult) -> float:
        assert r.trend is not None and r.value_canonical is not None  # noqa: S101
        previous = r.trend.previous_value
        return abs(r.value_canonical - previous) / abs(previous) if previous else 1.0

    notable = sorted((r for r in notable if r.value_canonical is not None), key=size, reverse=True)[
        :3
    ]
    current_date = extraction.report_date.value
    lines: list[str] = []
    for r in notable:
        trend = r.trend
        assert trend is not None and r.value_canonical is not None  # noqa: S101
        unit = pretty_unit(trend.unit)
        before = f"{format_number(trend.previous_value)} {unit}".strip()
        after = f"{format_number(r.value_canonical)} {unit}".strip()
        when_prev = f" ({trend.previous_date.strftime('%b %Y')})"
        when_now = f" ({current_date.strftime('%b %Y')})" if current_date else ""
        line = f"• {shown_name(r)}: {before}{when_prev} → {after}{when_now}"
        if trend.range_change == "into_range":
            line += f" — {t['now_in']}"
        elif trend.range_change == "out_of_range":
            line += f" — {t['now_out']}"
        lines.append(line)
    return lines


def doctor_questions(
    extraction: LabReportExtraction, index: LabIndex | None, language: Language
) -> list[str]:
    seen: list[str] = []
    ordered = sorted(
        extraction.results,
        key=lambda r: (r.status not in CRITICAL, r.status not in OUTSIDE),
    )
    for result in ordered:
        test = _test_of(result, index)
        if test is None:
            continue
        for question in test.questions_en if language is Language.en else test.questions_hi:
            if question not in seen:
                seen.append(question)
        if len(seen) >= MAX_QUESTIONS and result.status not in OUTSIDE:
            break
    return seen[:MAX_QUESTIONS]


# ------------------------------------------------------------------ the main reply


def render_lab_reply(
    extraction: LabReportExtraction,
    index: LabIndex | None,
    language: Language,
    *,
    minimum: float,
    mode: Mode = "full",
) -> str:
    t = TEXTS[language]
    results = extraction.results
    lines: list[str] = []

    critical = [r for r in results if r.status in CRITICAL]
    if critical:
        names = ", ".join(dict.fromkeys(shown_name(r) for r in critical))
        key = "critical_unconfirmed" if any(r.needs_confirmation for r in critical) else "critical"
        lines += [t[key].format(names=names), ""]

    when = report_date_of(extraction, minimum)
    if when is not None:
        lines.append(t["header"].format(date=format_date(when), n=len(results)))
    else:
        lines.append(t["header_nodate"].format(n=len(results)))

    normal = [r for r in results if r.status == "normal"]
    close = [r for r in results if r.status == "borderline"]
    outside = sorted(
        (r for r in results if r.status in OUTSIDE), key=lambda r: r.status not in CRITICAL
    )
    unknown = [r for r in results if r.status == "unknown"]
    if normal or close:
        lines.append(t["normal"].format(n=len(normal) + len(close)))

    if outside:
        lines.append(t["outside"])
        listed = outside[: max(MAX_OUTSIDE_LISTED, len(critical))]
        for r in listed:
            lines.append(result_line(r, _test_of(r, index), language, mode))
        if len(outside) > len(listed):
            lines.append(t["more"].format(n=len(outside) - len(listed)))
    if close and mode == "full":
        lines.append(t["close"])
        lines += [result_line(r, _test_of(r, index), language, "minimal") for r in close[:5]]
    if mode == "full":
        trends = trend_lines(extraction, language)
        if trends:
            lines.append(t["trend"])
            lines += trends
    if unknown:
        lines.append(t["confirm"])
        unread = 0
        for r in unknown[:8]:
            if r.raw_test_name.confidence < minimum:
                unread += 1  # not even the name is certain: it is counted, never shown
            elif r.value_raw.confidence < minimum:
                lines.append(f"• {shown_name(r)}")  # a value read with doubt is never repeated
            else:
                lines.append(f"• {shown_name(r)}: {shown_value(r)}")
        unread += max(0, len(unknown) - 8)
        if unread:
            lines.append(t["unread"].format(n=unread))
    unexplained = [
        r for r in results if r.test_code is None and r.status in ("normal", "borderline")
    ]
    if unexplained and mode == "full":
        lines.append(t["others"].format(n=len(unexplained)))

    if mode == "full":
        questions = doctor_questions(extraction, index, language)
        if questions:
            lines.append(t["questions"])
            lines += [f"{i}. {q}" for i, q in enumerate(questions, start=1)]
    if extraction.used_general_range:
        lines.append(t["general"])
    lines += ["", t["info"], "", DISCLAIMERS[language]]
    return _fit("\n".join(lines))


def _fit(text: str) -> str:
    if len(text) <= MAX_REPLY_CHARS:
        return text
    return text[: MAX_REPLY_CHARS - 1].rstrip() + "…"  # last resort; the verifier flags the cut


# ------------------------------------------------------------------ all tests


def render_all_tests(
    extraction: LabReportExtraction,
    index: LabIndex | None,
    language: Language,
    *,
    minimum: float,
) -> str:
    t = TEXTS[language]
    when = report_date_of(extraction, minimum)
    title = t["all_title"].format(date=f" ({format_date(when)})" if when else "")
    marks = {
        "normal": "✅", "borderline": "🟡", "high": "⚠️", "low": "⚠️", "critical_high": "🚨",
        "critical_low": "🚨", "qualitative_abnormal": "⚠️", "unknown": "🔎",
    }  # fmt: skip
    groups: dict[str, list[LabResult]] = {}
    for r in extraction.results:
        test = _test_of(r, index)
        section = clean_name(r.section) or (test.section if test else "") or t["other_section"]
        groups.setdefault(section, []).append(r)
    out = [title]
    shown = 0
    budget = MAX_REPLY_CHARS - len(DISCLAIMERS[language]) - len(t["info"]) - 200
    for section, items in groups.items():
        block = [f"\n{section}"]
        for r in items:
            word = (
                t.get(r.status, "")
                if r.status in OUTSIDE
                else {
                    "normal": t["ok"],
                    "borderline": t["close_short"],
                    "unknown": t["unclear"],
                }.get(r.status, "")
            )
            basis = _basis_text(r, language)
            line = f"{marks[r.status]} {shown_name(r)}: {shown_value(r)}"
            if basis:
                line += f" ({basis})"
            if word:
                line += f" — {word}"
            block.append(line)
        if len("\n".join(out + block)) > budget:
            break
        out += block
        shown += len(items)
    hidden = len(extraction.results) - shown
    if hidden > 0:
        out.append("\n" + t["all_more"].format(n=hidden))
    out += ["", t["info"], "", DISCLAIMERS[language]]
    return "\n".join(out)


# ------------------------------------------------------------------ typed question ("TSH 6.2 matlab kya?")


@dataclass(frozen=True, slots=True)
class LabQuestionAnswer:
    text: str
    test_code: str | None


def render_lab_question(
    test: LabTest | None, value: str | None, language: Language
) -> LabQuestionAnswer:
    """Explanation + general adult range + 'compare with YOUR report's range'. Never an interpretation."""
    t = TEXTS[language]
    if test is None:
        return LabQuestionAnswer("\n\n".join([t["q_unknown"], DISCLAIMERS[language]]), None)
    parts = [t["q_title"].format(name=test.name)]
    explanation = explanation_of(test, language)
    if explanation:
        parts.append(explanation)
    variant, _ = select_fallback(test, None, None)
    if variant is not None and (variant.low is not None or variant.high is not None):
        parts.append(
            t["q_range"].format(r=range_label(variant.low, variant.high), u=pretty_unit(test.unit))
        )
    if value:
        parts.append(t["q_value"].format(v=value))
    parts += [t["q_ask"], "", DISCLAIMERS[language]]
    return LabQuestionAnswer("\n".join(parts[:-2]) + "\n" + "\n".join(parts[-2:]), test.code)
