"""Deterministic validation and normalisation of a prescription extraction (M7). No LLM here.

The vision model READS; these small pure functions CHECK. Whenever the model's derived values
(frequency per day, timings, food relation) contradict what is literally written (`1-0-1`, `TDS`,
`PC` ...), the written code wins, the confidence of the contradicted field is pushed below the
threshold and a machine-readable note is added (CLAUDE.md §2.3: null/low confidence beats a guess).

Validation notes are stable tokens (`frequency_code_overrides_model`, ...). They never contain text
from the prescription, so they are safe to log and to show to the composer.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from app.schemas.prescription import (
    Field,
    FoodField,
    FoodRelation,
    IntField,
    Medicine,
    PrescriptionExtraction,
    TextField,
    Timing,
    TimingsField,
)

MAX_FREQUENCY_PER_DAY = 6
MIN_DURATION_DAYS = 1
MAX_DURATION_DAYS = 365
MAX_TABLET_DOSE_UNITS = 4.0
MAX_LIQUID_DOSE_ML = 50.0

_THREE_SLOT: tuple[Timing, ...] = ("morning", "afternoon", "night")
_FOUR_SLOT: tuple[Timing, ...] = ("morning", "afternoon", "evening", "night")


# ---------------------------------------------------------------- frequency


@dataclass(frozen=True, slots=True)
class FrequencyInfo:
    per_day: int | None  # None for as-needed
    timings: tuple[Timing, ...]  # only when the code itself names the times (1-0-1, HS)
    as_needed: bool = False


# Abbreviations (lower case, dots removed). Timings are filled ONLY when the abbreviation says when.
_CODE_TABLE: dict[str, FrequencyInfo] = {
    "od": FrequencyInfo(1, ()),
    "qd": FrequencyInfo(1, ()),
    "bd": FrequencyInfo(2, ()),
    "bid": FrequencyInfo(2, ()),
    "tds": FrequencyInfo(3, ()),
    "tid": FrequencyInfo(3, ()),
    "qid": FrequencyInfo(4, ()),
    "qds": FrequencyInfo(4, ()),
    "hs": FrequencyInfo(1, ("night",)),
    "sos": FrequencyInfo(None, (), as_needed=True),
    "prn": FrequencyInfo(None, (), as_needed=True),
}

_DOSE_SLOT = r"(?:\d+(?:\.\d+)?(?:/\d+)?|½|¼)"
_PATTERN = re.compile(rf"^{_DOSE_SLOT}(?:\s*[-–—]\s*{_DOSE_SLOT}){{2,3}}$")
_WORD_TIMES = {"once": 1, "twice": 2, "thrice": 3, "one": 1, "two": 2, "three": 3, "four": 4}
_TIMES_A_DAY = re.compile(
    r"\b(?:(?P<word>once|twice|thrice)\s*(?:a|per|in a|in)?\s*(?:day|daily)"
    r"|(?P<n>\d)\s*(?:times?|x|baar|bar|बार)\s*(?:a|per|in a|in)?\s*(?:day|daily|din|दिन)?)",
)
_HINDI_PER_DAY = re.compile(r"\b(?:din me|din mein|roz|daily)\s*(?P<n>\d)\s*(?:baar|bar)\b")
_Q_HOURLY = re.compile(r"^q\s*(\d{1,2})\s*h(?:rs?)?$")


def _slot_is_taken(slot: str) -> bool:
    slot = slot.strip()
    if slot in {"½", "¼"}:
        return True
    if "/" in slot:
        numerator, _, denominator = slot.partition("/")
        return numerator.isdigit() and denominator.isdigit() and int(numerator) > 0
    try:
        return float(slot) > 0
    except ValueError:
        return False


def parse_frequency_code(code: str | None) -> FrequencyInfo | None:
    """What a written frequency means, or None when it is not a form we understand.

    `1-0-1` -> 2 per day, [morning, night]; `1-1-1` -> 3; `0-0-1` -> 1 [night]; `OD`, `BD`, `TDS`,
    `QID`, `HS`, `SOS/PRN`; "twice daily", "3 times a day", "din me 2 baar"; `q6h` -> 4.
    """
    if code is None:
        return None
    text = code.strip().lower()
    if not text:
        return None

    compact = re.sub(r"[.\s]", "", text)
    if compact in _CODE_TABLE:
        return _CODE_TABLE[compact]

    if _PATTERN.match(text.replace("–", "-").replace("—", "-")):
        slots = [s for s in re.split(r"\s*[-–—]\s*", text) if s]
        timings_for = _THREE_SLOT if len(slots) == 3 else _FOUR_SLOT
        taken = tuple(t for t, slot in zip(timings_for, slots, strict=True) if _slot_is_taken(slot))
        if not taken:
            return None  # 0-0-0: nothing is taken, so it is not a schedule
        return FrequencyInfo(len(taken), taken)

    hourly = _Q_HOURLY.match(compact)
    if hourly:
        hours = int(hourly.group(1))
        if 0 < hours <= 24 and 24 % hours == 0:
            return FrequencyInfo(24 // hours, ())
        return None

    match = _TIMES_A_DAY.search(text) or _HINDI_PER_DAY.search(text)
    if match:
        groups = match.groupdict()
        word = groups.get("word")
        if word:
            return FrequencyInfo(_WORD_TIMES[word], ())
        digit = groups.get("n")
        if digit and digit.isdigit() and int(digit) > 0:
            return FrequencyInfo(int(digit), ())
    if re.fullmatch(r"(?:once\s+)?(?:daily|a day|every day|roz)", text):
        return FrequencyInfo(1, ())
    return None


# ---------------------------------------------------------------- food relation

_BEFORE_LONG = re.compile(
    r"before\s+(?:food|meals?|eating|breakfast|lunch|dinner)|khane\s+se\s+pehle|"
    r"khali\s+pet|empty\s+stomach|खाने\s+से\s+पहले|खाली\s+पेट"
)
_AFTER_LONG = re.compile(
    r"after\s+(?:food|meals?|eating|breakfast|lunch|dinner)|khane\s+ke\s+baad|खाने\s+के\s+बाद"
)
_WITH_LONG = re.compile(r"with\s+(?:food|meals?|milk)|khane\s+ke\s+saath|खाने\s+के\s+साथ")
_BEFORE_ABBR = re.compile(r"(?<![a-z])a\.?\s?c\.?(?![a-z])")
_AFTER_ABBR = re.compile(r"(?<![a-z])p\.?\s?c\.?(?![a-z])")


def parse_food_relation(
    *texts: str | None, allow_abbreviations: bool = True
) -> FoodRelation | None:
    """`before` / `after` / `with` when the written text says so, None when silent OR contradictory."""
    found: set[FoodRelation] = set()
    for raw in texts:
        if not raw:
            continue
        text = raw.lower()
        if _BEFORE_LONG.search(text):
            found.add("before")
        if _AFTER_LONG.search(text):
            found.add("after")
        if _WITH_LONG.search(text):
            found.add("with")
        if allow_abbreviations:
            if _BEFORE_ABBR.search(text):
                found.add("before")
            if _AFTER_ABBR.search(text):
                found.add("after")
    return next(iter(found)) if len(found) == 1 else None


# ---------------------------------------------------------------- strength / dose / duration

_STRENGTH = re.compile(
    r"^(?P<num>\d+(?:\.\d+)?)\s?(?P<unit>mg|mcg|µg|μg|ug|g|ml|iu|%)"
    r"(?:\s?/\s?(?P<per>\d+(?:\.\d+)?)?\s?(?P<per_unit>ml|g|mg))?$",
    re.IGNORECASE,
)


def normalise_strength(text: str | None) -> str | None:
    """`650mg` -> `650 mg`, `125 MG/5ML` -> `125 mg/5 ml`; None when it is not a plausible strength."""
    if text is None:
        return None
    match = _STRENGTH.match(text.strip())
    if match is None:
        return None
    number = match.group("num")
    if float(number) <= 0:
        return None
    unit = match.group("unit").lower().replace("µg", "mcg").replace("μg", "mcg")
    unit = "mcg" if unit == "ug" else unit
    result = f"{number} {unit}" if unit != "%" else f"{number}%"
    if match.group("per_unit"):
        per = match.group("per")
        result += f"/{per + ' ' if per else ''}{match.group('per_unit').lower()}"
    return result


_FRACTIONS = {"½": Fraction(1, 2), "¼": Fraction(1, 4), "¾": Fraction(3, 4)}
_NUMBER_WORDS = {
    "one": 1.0,
    "two": 2.0,
    "three": 3.0,
    "four": 4.0,
    "half": 0.5,
    "ek": 1.0,
    "aadha": 0.5,
    "adha": 0.5,
}
_DOSE = re.compile(
    r"^\s*(?P<amount>\d+(?:\.\d+)?(?:\s?/\s?\d+)?|[½¼¾]|one|two|three|four|half|ek|aadha|adha)"
    r"\s*(?P<unit>[a-zA-Z]+)?",
    re.IGNORECASE,
)
_TABLET_UNITS = frozenset(
    {"tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules"}
)
_TABLET_UNITS_HI = frozenset({"goli", "golis", "golia"})


def dose_amount(text: str | None) -> tuple[float, str] | None:
    """`(1.0, "tablet")` for "1 tablet", `(0.5, "tab")` for "1/2 tab"; None if no leading number."""
    if text is None:
        return None
    match = _DOSE.match(text)
    if match is None:
        return None
    raw = match.group("amount").lower().replace(" ", "")
    unit = (match.group("unit") or "").lower()
    if raw in _FRACTIONS:
        amount = float(_FRACTIONS[raw])
    elif raw in _NUMBER_WORDS:
        amount = _NUMBER_WORDS[raw]
    elif "/" in raw:
        numerator, _, denominator = raw.partition("/")
        if not denominator or int(denominator) == 0:
            return None
        amount = int(numerator) / int(denominator)
    else:
        amount = float(raw)
    return amount, unit


def dose_in_range(dose: str | None, form: str | None) -> bool:
    """False for an implausible dose (more than 4 tablets at once, more than 50 ml at once, zero)."""
    parsed = dose_amount(dose)
    if parsed is None:
        return True  # nothing numeric to check; the model's confidence still applies
    amount, unit = parsed
    if amount <= 0:
        return False
    is_tablet = (
        unit in _TABLET_UNITS
        or unit in _TABLET_UNITS_HI
        or (not unit and form in {"tablet", "capsule"})
    )
    if is_tablet and amount > MAX_TABLET_DOSE_UNITS:
        return False
    return not (unit == "ml" and amount > MAX_LIQUID_DOSE_ML)


def duration_in_range(days: int | None) -> bool:
    return days is not None and MIN_DURATION_DAYS <= days <= MAX_DURATION_DAYS


# ---------------------------------------------------------------- applying the rules


def _lowered(field: Field[Any], min_confidence: float) -> float:
    """A confidence strictly below the threshold, and never higher than it was."""
    return round(min(field.confidence, max(0.0, min_confidence - 0.05)), 3)


def effective_frequency_confidence(medicine: Medicine) -> float:
    """How sure we are about "how often": the written code AND the derived number must be solid."""
    code = medicine.frequency_code.confidence if medicine.frequency_code.value else 0.0
    if medicine.as_needed:
        return code
    per_day = medicine.frequency_per_day.confidence if medicine.frequency_per_day.value else 0.0
    return min(code, per_day)


def validate_medicine(medicine: Medicine, min_confidence: float) -> Medicine:
    """Apply every deterministic rule to ONE medicine; returns a corrected copy."""
    updated = medicine.model_copy(deep=True)
    notes: list[str] = []

    # --- frequency: the written code is the truth
    info = parse_frequency_code(updated.frequency_code.value)
    if info is not None:
        if info.as_needed:
            updated.as_needed = True
            if updated.frequency_per_day.value is not None:
                notes.append("frequency_code_overrides_model")
            updated.frequency_per_day = IntField(
                value=None, confidence=updated.frequency_code.confidence
            )
        else:
            if (
                updated.frequency_per_day.value is not None
                and updated.frequency_per_day.value != info.per_day
            ):
                notes.append("frequency_code_overrides_model")
                lowered = _lowered(updated.frequency_per_day, min_confidence)
                updated.frequency_per_day = IntField(value=info.per_day, confidence=lowered)
            else:
                updated.frequency_per_day = IntField(
                    value=info.per_day,
                    confidence=updated.frequency_per_day.confidence
                    if updated.frequency_per_day.value is not None
                    else updated.frequency_code.confidence,
                )
            if info.timings:
                if updated.timings.value and set(updated.timings.value) != set(info.timings):
                    notes.append("timings_overridden_by_code")
                updated.timings = TimingsField(
                    value=list(info.timings), confidence=updated.frequency_code.confidence
                )
    elif updated.as_needed and updated.frequency_per_day.value is not None:
        # The model says "as needed" but also gave a daily count: the count is not meaningful.
        updated.frequency_per_day = IntField(value=None, confidence=0.0)
        notes.append("as_needed_has_no_daily_count")

    per_day = updated.frequency_per_day.value
    if per_day is not None and not 1 <= per_day <= MAX_FREQUENCY_PER_DAY:
        notes.append("frequency_out_of_range")
        updated.frequency_per_day = IntField(
            value=per_day, confidence=_lowered(updated.frequency_per_day, min_confidence)
        )

    # --- timings from the model must match the daily count, otherwise they are dropped
    timings = updated.timings.value
    if timings and per_day is not None and len(set(timings)) != per_day:
        notes.append("timings_count_mismatch")
        updated.timings = TimingsField(value=None, confidence=0.0)

    # --- food relation: written abbreviations / phrases beat the model's reading
    written_relation = parse_food_relation(updated.frequency_code.value, updated.instructions.value)
    if written_relation is None:
        written_relation = parse_food_relation(updated.raw_text.value, allow_abbreviations=False)
    if written_relation is not None and updated.relation_to_food.value != written_relation:
        if updated.relation_to_food.value is not None:
            notes.append("food_relation_overrides_model")
            confidence = _lowered(updated.relation_to_food, min_confidence)
        else:
            confidence = updated.frequency_code.confidence or updated.raw_text.confidence
        updated.relation_to_food = FoodField(value=written_relation, confidence=confidence)

    # --- strength: must look like a strength, otherwise it is not shown or stored
    if updated.strength.value is not None:
        normalised = normalise_strength(updated.strength.value)
        if normalised is None:
            notes.append("strength_invalid")
            updated.strength = TextField(value=None, confidence=0.0)
        else:
            updated.strength = TextField(value=normalised, confidence=updated.strength.confidence)

    # --- dose: an implausible amount must be confirmed by a human
    if updated.dose.value is not None and not dose_in_range(updated.dose.value, updated.form.value):
        notes.append("dose_out_of_range")
        updated.dose = TextField(
            value=updated.dose.value, confidence=_lowered(updated.dose, min_confidence)
        )

    # --- duration: an impossible number is dropped, not shown
    if updated.duration_days.value is not None and not duration_in_range(
        updated.duration_days.value
    ):
        notes.append("duration_out_of_range")
        updated.duration_days = IntField(value=None, confidence=0.0)

    updated.validation_notes = list(dict.fromkeys([*updated.validation_notes, *notes]))[:10]
    return updated


def _name_key(medicine: Medicine) -> str:
    return re.sub(r"[^a-z0-9ऀ-ॿ]", "", (medicine.name.value or "").lower())


def merge_duplicates(medicines: Sequence[Medicine]) -> list[Medicine]:
    """Drop exact repeats (same name, strength, frequency, dose and duration); flag the rest.

    A repeated line is usually the model reading a header twice. The same drug with a different
    schedule can be legitimate (tapering), so it is kept and noted, never silently merged.
    """
    result: list[Medicine] = []
    seen: dict[tuple[str, str | None, str | None, str | None, int | None], int] = {}
    by_name: dict[str, list[int]] = {}
    for medicine in medicines:
        key = _name_key(medicine)
        if not key:
            result.append(medicine)
            continue
        identity = (
            key,
            medicine.strength.value,
            medicine.frequency_code.value,
            medicine.dose.value,
            medicine.duration_days.value,
        )
        if identity in seen:
            kept = result[seen[identity]]
            kept.validation_notes = list(
                dict.fromkeys([*kept.validation_notes, "duplicate_merged"])
            )
            continue
        seen[identity] = len(result)
        by_name.setdefault(key, []).append(len(result))
        result.append(medicine)
    for indexes in by_name.values():
        if len(indexes) > 1:
            for index in indexes:
                notes = result[index].validation_notes
                result[index].validation_notes = list(dict.fromkeys([*notes, "duplicate_name"]))
    return result


def validate_extraction(
    extraction: PrescriptionExtraction, min_confidence: float
) -> PrescriptionExtraction:
    """Validate every medicine, merge repeats and recompute `overall_confidence`.

    `overall_confidence` is the MINIMUM of the critical fields (name, dose, frequency) over all
    medicines: the weakest link decides, so one unreadable line cannot hide behind good ones.
    """
    medicines = merge_duplicates(
        [validate_medicine(m, min_confidence) for m in extraction.medicines]
    )
    critical: list[float] = []
    for medicine in medicines:
        critical.append(medicine.name.confidence if medicine.name.value else 0.0)
        critical.append(medicine.dose.confidence if medicine.dose.value else 0.0)
        critical.append(effective_frequency_confidence(medicine))
    overall = round(min(critical), 3) if critical else 0.0
    return extraction.model_copy(update={"medicines": medicines, "overall_confidence": overall})
