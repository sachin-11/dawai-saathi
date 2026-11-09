"""Range comparison, critical values and trends for a lab report (M12). Deterministic: no LLM.

Which range a value is compared with (CLAUDE.md §7.3, the lab's own range wins because reference
ranges depend on the lab's method and machine):
  1. the lab's PRINTED range, when it was read with enough confidence
  2. the lab's printed H / L flag, when the range is not usable
  3. the fallback range of `lab_tests` for the patient's age / sex (general adult range, and the reply
     says so, when age or sex is not known)
A printed range that is a list of CATEGORIES ("Deficient <20, Insufficient 20-29 ...") is never turned
into normal / abnormal by us: the category label is shown as printed and the status comes from the
printed flag, else from the fallback range, else stays unknown.

A critical value (`critical_values.yaml`, canonical unit) overrides every other status. It is also raised
when the value was read with low confidence: for safety, missing a critical value is the worse error.
"""

import re
from dataclasses import dataclass
from datetime import date
from typing import Literal

from app.labs.catalog import LabTest, RangeVariant
from app.safety.critical_values import critical_status
from app.schemas.lab_report import (
    LabReportExtraction,
    LabResult,
    RangeBasis,
    ResultStatus,
    Trend,
    TrendDirection,
)
from app.schemas.process import PreviousLabResult
from app.tools.lab_normalize import (
    QUALITATIVE_NEGATIVE,
    QUALITATIVE_POSITIVE,
    LabIndex,
    conversion_factor,
    normalise_unit,
    parse_value,
)

Outcome = Literal["normal", "high", "low", "unknown"]
RangeChange = Literal["into_range", "out_of_range"]
_FLAG_STATUS: dict[str, ResultStatus] = {
    "H": "high",
    "L": "low",
    "N": "normal",
    "A": "qualitative_abnormal",
}

BORDERLINE_FRACTION = 0.05
BORDERLINE_WIDTH_FRACTION = 0.10
SAME_FRACTION = 0.01  # a change below 1% is "same"
MAX_TREND_LINES = 3


# ------------------------------------------------------------------ fallback range selection


def select_fallback(
    test: LabTest, age: int | None, sex: str | None
) -> tuple[RangeVariant | None, bool]:
    """(variant, is_general). `is_general` is True when age or sex was needed but unknown."""
    sex_specific = any(r.sex != "any" for r in test.ranges)
    general = age is None or (sex is None and sex_specific)
    effective_age = 30 if age is None else age  # unknown age = a typical adult, and we say so

    def fits(r: RangeVariant) -> bool:
        return (r.age_min is None or effective_age >= r.age_min) and (
            r.age_max is None or effective_age <= r.age_max
        )

    pool = [r for r in test.ranges if fits(r)]
    if sex is not None:
        exact = [r for r in pool if r.sex == sex]
        if exact:
            return exact[0], age is None
    anyone = [r for r in pool if r.sex == "any"]
    if anyone:
        return anyone[0], general
    return None, general


# ------------------------------------------------------------------ printed categories

_SEGMENT = re.compile(
    r"^\s*(?P<label>[^\d<>≥≤=]*?[A-Za-z][^\d<>≥≤=]*?)\s*[:\-]?\s*"
    r"(?P<op><=|>=|<|>|≤|≥)?\s*(?P<a>\d+(?:\.\d+)?)"
    r"(?:\s*(?:-|–|to)\s*(?P<b>\d+(?:\.\d+)?))?\s*[A-Za-z%/]*\s*$"
)


@dataclass(frozen=True, slots=True)
class Category:
    label: str
    low: float | None
    high: float | None
    low_inclusive: bool
    high_inclusive: bool

    def contains(self, value: float) -> bool:
        if self.low is not None and (
            value < self.low or (value == self.low and not self.low_inclusive)
        ):
            return False
        return not (
            self.high is not None
            and (value > self.high or (value == self.high and not self.high_inclusive))
        )


def parse_categories(text: str | None) -> list[Category]:
    """Labelled segments such as 'Pre-diabetic: 5.7-6.4, Diabetic >= 6.5'. Fewer than two parsed
    segments means this is an ordinary range, not a category list."""
    if not text:
        return []
    categories: list[Category] = []
    for part in re.split(r"[,;\n|]", text):
        found = _SEGMENT.match(part)
        if not found:
            continue
        label = found.group("label").strip(" :-")
        if not 3 <= len(label) <= 40:
            continue
        op, a = found.group("op"), float(found.group("a"))
        b = float(found.group("b")) if found.group("b") else None
        if b is not None:
            categories.append(Category(label, a, b, True, True))
        elif op in ("<", "<=", "≤"):
            categories.append(Category(label, None, a, True, op != "<"))
        elif op in (">", ">=", "≥"):
            categories.append(Category(label, a, None, op != ">", True))
    return categories if len(categories) >= 2 else []


# ------------------------------------------------------------------ value against a range


def classify_against(
    value: float, comparator: str, low: float | None, high: float | None
) -> Outcome:
    """'normal' | 'high' | 'low' | 'unknown' for a value, a limit-only value ('<0.5') and a range."""
    if low is None and high is None:
        return "unknown"
    if comparator == "=":
        if low is not None and value < low:
            return "low"
        if high is not None and value > high:
            return "high"
        return "normal"
    if comparator == "<":  # the true value is below `value`
        if low is not None and value <= low:
            return "low"
        if high is not None and value <= high and (low is None or low <= 0):
            return "normal"
        return "unknown"
    # ">": the true value is above `value`
    if high is not None and value >= high:
        return "high"
    if high is None and (low is None or value >= low):
        return "normal"
    return "unknown"


def is_borderline(value: float, low: float | None, high: float | None) -> bool:
    """Inside the range but within 5% of a limit. For a narrow range (sodium 135-145) 5% of the limit
    would cover most of it, so the margin is also capped at 10% of the range width."""
    cap = (high - low) * BORDERLINE_WIDTH_FRACTION if low is not None and high is not None else None

    def margin(limit: float) -> float:
        fraction = BORDERLINE_FRACTION * limit
        return fraction if cap is None else min(fraction, cap)

    if low is not None and low > 0 and value - low <= margin(low):
        return True
    return high is not None and high > 0 and high - value <= margin(high)


def _format_number(value: float) -> str:
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return text or "0"


def range_label(low: float | None, high: float | None) -> str:
    if low is not None and high is not None:
        return f"{_format_number(low)}–{_format_number(high)}"
    if high is not None:
        return f"< {_format_number(high)}"
    if low is not None:
        return f"> {_format_number(low)}"
    return ""


# ------------------------------------------------------------------ one result


@dataclass(frozen=True, slots=True)
class Patient:
    age: int | None
    sex: str | None


def _confident(field_value: object, confidence: float, minimum: float) -> bool:
    return field_value is not None and confidence >= minimum


def compare_result(
    result: LabResult, test: LabTest | None, patient: Patient, minimum: float
) -> tuple[LabResult, bool]:
    """(result with status etc., used_general_range)."""
    parsed = parse_value(result.value_raw.value)
    name_ok = _confident(result.raw_test_name.value, result.raw_test_name.confidence, minimum)
    value_ok = _confident(result.value_raw.value, result.value_raw.confidence, minimum)
    unit_text = result.unit.value
    unit_ok = unit_text is None or result.unit.confidence >= minimum
    needs_confirmation = not (name_ok and value_ok and unit_ok)

    status: ResultStatus = "unknown"
    basis: RangeBasis = "none"
    range_text: str | None = None
    category: str | None = None
    general = False

    # ---- critical first: it overrides everything, also for a value read with low confidence
    if (
        test is not None
        and parsed.kind == "numeric"
        and parsed.number is not None
        and result.value_canonical is not None
    ):
        crit = _critical(test.code, result.value_canonical, result.value_comparator)
        if crit:
            return (
                result.model_copy(
                    update={
                        "status": crit,
                        "needs_confirmation": needs_confirmation,
                        "range_basis": "none",
                    }
                ),
                False,
            )

    if parsed.kind == "qualitative":
        status, basis = _qualitative_status(parsed.qualitative or "", test, result, minimum)
        return (
            result.model_copy(
                update={
                    "status": status if value_ok else "unknown",
                    "range_basis": basis,
                    "needs_confirmation": needs_confirmation,
                }
            ),
            False,
        )

    if parsed.kind != "numeric" or parsed.number is None or not value_ok:
        return (
            result.model_copy(update={"status": "unknown", "needs_confirmation": True}),
            False,
        )

    value, comparator = parsed.number, result.value_comparator
    categories = (
        parse_categories(result.lab_ref_text.value)
        if result.lab_ref_text.confidence >= minimum
        else []
    )
    if categories:
        for item in categories:
            if comparator == "=" and item.contains(value):
                category = item.label
                break
    printed_ok = not categories and (
        _confident(result.lab_ref_low.value, result.lab_ref_low.confidence, minimum)
        or _confident(result.lab_ref_high.value, result.lab_ref_high.confidence, minimum)
    )
    flag = result.lab_flag.value if result.lab_flag.confidence >= minimum else None

    if printed_ok:
        low = result.lab_ref_low.value if result.lab_ref_low.confidence >= minimum else None
        high = result.lab_ref_high.value if result.lab_ref_high.confidence >= minimum else None
        outcome = classify_against(value, comparator, low, high)
        if outcome != "unknown":
            status = outcome
            basis, range_text = "printed", range_label(low, high)
            if status == "normal" and comparator == "=" and is_borderline(value, low, high):
                status = "borderline"
    if status == "unknown" and flag is not None and flag in ("H", "L", "N", "A"):
        status = _FLAG_STATUS[flag]
        basis = "flag"
        range_text = result.lab_ref_text.value if categories else None
    if status == "unknown" and test is not None and result.value_canonical is not None:
        variant, general = select_fallback(test, patient.age, patient.sex)
        if variant is not None and comparator == "=":
            outcome = classify_against(result.value_canonical, "=", variant.low, variant.high)
            if outcome != "unknown":
                status = outcome
                basis, range_text = "fallback", range_label(variant.low, variant.high)
                if status == "normal" and is_borderline(
                    result.value_canonical, variant.low, variant.high
                ):
                    status = "borderline"
        else:
            general = False

    if needs_confirmation and status != "unknown":
        # A weak read must not produce a confident verdict: keep it visible as "please confirm".
        status = "unknown"
    return (
        result.model_copy(
            update={
                "status": status,
                "range_basis": basis,
                "range_text": range_text,
                "category": category if categories else None,
                "needs_confirmation": needs_confirmation,
            }
        ),
        general and basis == "fallback",
    )


def _critical(code: str, canonical: float, comparator: str) -> ResultStatus | None:
    if comparator == "=":
        found = critical_status(code, canonical)
    elif comparator == "<":
        found = critical_status(code, canonical - 1e-9)  # "< x": the true value is at most x
    else:
        found = critical_status(code, canonical + 1e-9)
    return found  # type: ignore[return-value]


def _qualitative_status(
    word: str, test: LabTest | None, result: LabResult, minimum: float
) -> tuple[ResultStatus, RangeBasis]:
    flag = result.lab_flag.value if result.lab_flag.confidence >= minimum else None
    positive = word in QUALITATIVE_POSITIVE
    negative = word in QUALITATIVE_NEGATIVE
    if test is not None and test.is_qualitative:
        if positive:
            return "qualitative_abnormal", "fallback"
        if negative or word in test.qualitative_normal:
            return "normal", "fallback"
    if flag in ("H", "L", "A"):
        return "qualitative_abnormal", "flag"
    if flag == "N":
        return "normal", "flag"
    return "unknown", "none"


# ------------------------------------------------------------------ trends


def _effective_range(
    result: LabResult, test: LabTest, patient: Patient
) -> tuple[float | None, float | None]:
    """The range the status used, expressed in the canonical unit (for the 'into / out of range' note)."""
    if result.range_basis == "printed":
        factor = conversion_factor(test, normalise_unit(result.unit.value))
        if factor is None:
            return None, None
        low = result.lab_ref_low.value
        high = result.lab_ref_high.value
        return (None if low is None else low * factor, None if high is None else high * factor)
    if result.range_basis == "fallback":
        variant, _ = select_fallback(test, patient.age, patient.sex)
        if variant is not None:
            return variant.low, variant.high
    return None, None


def apply_trend(
    result: LabResult,
    test: LabTest | None,
    previous: list[PreviousLabResult],
    report_date: date | None,
    patient: Patient,
) -> LabResult:
    if (
        test is None
        or result.value_canonical is None
        or result.value_comparator != "="
        or result.status in ("unknown", "qualitative_abnormal")
    ):
        return result
    candidates = [
        p
        for p in previous
        if p.test_code == test.code
        and normalise_unit(p.unit) == test.unit
        and (report_date is None or p.report_date < report_date)
    ]
    if not candidates:
        return result
    last = max(candidates, key=lambda p: p.report_date)
    current = result.value_canonical
    if last.value == 0:
        same = current == 0
        change = 0.0 if same else 1.0
    else:
        change = (current - last.value) / abs(last.value)
    direction: TrendDirection = (
        "same" if abs(change) < SAME_FRACTION else ("up" if change > 0 else "down")
    )
    range_change: RangeChange | None = None
    low, high = _effective_range(result, test, patient)
    if low is not None or high is not None:
        was_in = classify_against(last.value, "=", low, high) == "normal"
        now_in = result.status in ("normal", "borderline")
        if now_in and not was_in:
            range_change = "into_range"
        elif was_in and not now_in:
            range_change = "out_of_range"
    return result.model_copy(
        update={
            "trend": Trend(
                direction=direction,
                previous_value=last.value,
                previous_date=last.report_date,
                unit=test.unit,
                range_change=range_change,
            )
        }
    )


# ------------------------------------------------------------------ the whole report


def compare_report(
    extraction: LabReportExtraction,
    index: LabIndex,
    *,
    minimum: float,
    user_age: int | None,
    user_sex: str | None,
    previous: list[PreviousLabResult],
) -> LabReportExtraction:
    """Statuses, critical flags, trends. The age and sex printed on the report are used when they were
    read with confidence; they stay on the document and are never copied to the user's profile."""
    age = (
        extraction.patient_age.value
        if _confident(extraction.patient_age.value, extraction.patient_age.confidence, minimum)
        else user_age
    )
    sex = (
        extraction.patient_sex.value
        if _confident(extraction.patient_sex.value, extraction.patient_sex.confidence, minimum)
        else user_sex
    )
    patient = Patient(age, sex)
    report_date = (
        extraction.report_date.value if extraction.report_date.confidence >= minimum else None
    )
    results: list[LabResult] = []
    used_general = False
    for result in extraction.results:
        test = index.by_code.get(result.test_code) if result.test_code else None
        compared, general = compare_result(result, test, patient, minimum)
        used_general = used_general or general
        results.append(apply_trend(compared, test, previous, report_date, patient))
    return extraction.model_copy(
        update={
            "results": results,
            "has_critical": any(r.status in ("critical_high", "critical_low") for r in results),
            "used_general_range": used_general,
            "unknown_count": sum(1 for r in results if r.status == "unknown"),
        }
    )
