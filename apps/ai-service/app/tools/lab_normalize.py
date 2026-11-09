"""Lab result normalisation (M12). Deterministic: no LLM touches a number, a unit or a test name.

  parse_value      "7.2", "1,25,000", "<0.5", "1.2 x 10^3", "Positive" -> a typed value
  normalise_unit   "gm/dL", "lakhs/cu.mm", "µIU/mL", "10³/µL" -> one spelling per unit
  LabIndex         test name -> catalog test (exact alias, then trigram similarity with a margin)
  normalize_report fills `test_code`, `value_num`, `value_canonical`, `unit_canonical` on every result

The reply always shows the value AS PRINTED; the canonical value exists only for comparison, critical
checks and trends. A name that cannot be mapped with certainty stays unmapped ("other tests") and is
never explained: an unknown test is never guessed (CLAUDE.md §2.5).
"""

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

from app.labs.catalog import LabTest
from app.safety.injection import looks_like_instruction
from app.schemas.lab_report import LabReportExtraction, LabResult

# ------------------------------------------------------------------ values

_SUPERSCRIPTS = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁻", "0123456789-")
_SUP_RUN = re.compile(r"[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+")

QUALITATIVE_POSITIVE = frozenset(
    {"positive", "present", "reactive", "detected", "trace", "+", "++", "+++", "++++", "1+", "2+",
     "3+", "4+", "abnormal", "seen"}
)  # fmt: skip
QUALITATIVE_NEGATIVE = frozenset(
    {"negative", "nil", "absent", "not detected", "non reactive", "nonreactive", "normal",
     "not seen", "none"}
)  # fmt: skip

Comparator = Literal["<", ">", "="]
ValueKind = Literal["numeric", "qualitative", "unparsed"]


@dataclass(frozen=True, slots=True)
class ParsedValue:
    kind: ValueKind
    number: float | None = None
    comparator: Comparator = "="
    qualitative: str | None = None  # lower-case word for a qualitative value


_THOUSANDS = re.compile(r"^\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d+)?$")
_DECIMAL_COMMA = re.compile(r"^\d+,\d{1,2}$")
_NUMBER = r"\d+(?:\.\d+)?"
_SCI = re.compile(rf"^({_NUMBER})\s*[x×*]\s*10\s*\^?\s*(-?\d{{1,2}})$", re.IGNORECASE)
_E_NOTATION = re.compile(r"^(\d+(?:\.\d+)?[eE][+-]?\d{1,2})$")
_PLAIN = re.compile(rf"^({_NUMBER})\s*%?$")


def _clean_number(text: str) -> float | None:
    """A single number as printed, thousands separators removed. None when it is not one."""
    candidate = text.strip()
    if _THOUSANDS.match(candidate):
        candidate = candidate.replace(",", "")
    elif _DECIMAL_COMMA.match(candidate):
        candidate = candidate.replace(",", ".")
    candidate = candidate.rstrip("%").strip()
    if _PLAIN.match(candidate):
        return float(candidate)
    if _E_NOTATION.match(candidate):
        return float(candidate)
    sci = _SCI.match(candidate)
    if sci:
        return float(sci.group(1)) * (10.0 ** int(sci.group(2)))
    return None


def parse_value(raw: str | None) -> ParsedValue:
    if raw is None:
        return ParsedValue("unparsed")
    text = _SUP_RUN.sub(lambda m: "^" + m.group(0).translate(_SUPERSCRIPTS), raw)
    text = unicodedata.normalize("NFKC", text).strip().lower()
    if not text:
        return ParsedValue("unparsed")
    if text in QUALITATIVE_POSITIVE or text in QUALITATIVE_NEGATIVE:
        return ParsedValue("qualitative", qualitative=text)
    comparator: Comparator = "="
    body = text
    symbols: tuple[tuple[str, Comparator], ...] = (
        ("<=", "<"),
        ("≤", "<"),
        ("<", "<"),
        (">=", ">"),
        ("≥", ">"),
        (">", ">"),
    )
    for symbol, comp in symbols:
        if body.startswith(symbol):
            comparator = comp
            body = body[len(symbol) :].strip()
            break
    number = _clean_number(body)
    if number is None:
        return ParsedValue("unparsed")
    return ParsedValue("numeric", number=number, comparator=comparator)


# ------------------------------------------------------------------ units

_UNIT_SUBS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"cu\.?mm\.?|cmm|mm\^?3|cu\.?millimet(?:er|re)"), "cumm"),
    (re.compile(r"lakhs?|lacs?"), "lakhs"),
    (re.compile(r"gms?/dl|gram/dl|gm%|gms%|g%"), "g/dl"),
    (re.compile(r"gms?/l"), "g/l"),
    (re.compile(r"mg%"), "mg/dl"),
    (re.compile(r"m\^2"), "m2"),
    (re.compile(r"/hpf\.?|/hpf\(.*\)"), "/hpf"),
    (re.compile(r"^(?:mm/(?:1st|1)?(?:hr|hour|h)\.?|mm/1sthour|mm/1sthr)$"), "mm/hr"),
    (re.compile(r"^thou/"), "thou/"),
)


def normalise_unit(raw: str | None) -> str:
    """One spelling per unit: lower case, no spaces, micro sign -> u, superscripts -> ^n. '' for none."""
    if not raw:
        return ""
    text = _SUP_RUN.sub(lambda m: "^" + m.group(0).translate(_SUPERSCRIPTS), raw)
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("μ", "u").replace("µ", "u").replace("×", "x")
    text = re.sub(r"\s+", "", text).strip(".")
    for pattern, replacement in _UNIT_SUBS:
        text = pattern.sub(replacement, text)
    if re.match(r"^x10\^", text):
        text = text[1:]
    return text.replace("x10^", "10^")


# ------------------------------------------------------------------ names

_NOISE = frozenset(
    {"serum", "plasma", "blood", "level", "levels", "test", "estimation", "s", "calculated", "by",
     "method", "quantitative", "whole", "edta", "sample", "the", "of"}
)  # fmt: skip
_PAREN = re.compile(r"\(([^)]*)\)")


def normalise_name(raw: str) -> str:
    text = unicodedata.normalize("NFKC", raw).lower().replace("&", " and ")
    text = re.sub(r"[^\w+\-/\s%]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _candidates(raw: str) -> list[str]:
    """The printed name as written, outside the brackets, inside the brackets, without noise words."""
    full = normalise_name(raw)
    outside = normalise_name(_PAREN.sub(" ", raw))
    inside = [normalise_name(m) for m in _PAREN.findall(raw)]
    out: list[str] = []
    for item in (full, outside, *inside):
        if item and item not in out:
            out.append(item)
    for item in list(out):
        trimmed = " ".join(w for w in item.split() if w not in _NOISE)
        if trimmed and trimmed not in out:
            out.append(trimmed)
    return out


def _trigrams(text: str) -> frozenset[str]:
    """pg_trgm style: each word padded with two spaces in front and one behind."""
    grams: set[str] = set()
    for word in text.split():
        padded = f"  {word} "
        grams.update(padded[i : i + 3] for i in range(len(padded) - 2))
    return frozenset(grams)


def similarity(a: str, b: str) -> float:
    ta, tb = _trigrams(a), _trigrams(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


FUZZY_MIN = 0.6
FUZZY_MARGIN = 0.1
FUZZY_MIN_CHARS = 5  # short names (Hb, T3, K, Na) are matched by exact alias only
SECTION_BOOST = 0.1


@dataclass(frozen=True, slots=True)
class TestMatch:
    __test__ = False  # not a pytest class

    test: LabTest
    score: float
    method: Literal["alias", "fuzzy"]


def unit_compatible(test: LabTest, unit_norm: str) -> bool:
    """A printed unit the test can be converted from (or equals the canonical one). No printed unit is
    accepted for unit-less tests only; for others the caller decides (the match stays, the canonical
    value stays empty)."""
    if unit_norm == test.unit or unit_norm in test.conversions:
        return True
    return unit_norm in ("", "ratio") and test.unit in ("", "ratio")


class LabIndex:
    def __init__(self, tests: list[LabTest]) -> None:
        self.tests = tests
        self.by_code = {t.code: t for t in tests}
        self._alias: dict[str, LabTest] = {}
        self._fuzzy: list[tuple[str, LabTest]] = []
        for test in tests:
            names = {normalise_name(test.name), *(normalise_name(a) for a in test.aliases)}
            for name in names:
                self._alias.setdefault(name, test)
                if len(name) >= FUZZY_MIN_CHARS:
                    self._fuzzy.append((name, test))

    def match(
        self, raw_name: str, unit: str | None = None, section: str | None = None
    ) -> TestMatch | None:
        unit_norm = normalise_unit(unit)
        candidates = _candidates(raw_name)
        for candidate in candidates:
            test = self._alias.get(candidate)
            if test is not None and (not unit_norm or unit_compatible(test, unit_norm)):
                return TestMatch(test, 1.0, "alias")
        section_norm = normalise_name(section or "")
        scores: dict[str, float] = {}
        for candidate in candidates:
            if len(candidate) < FUZZY_MIN_CHARS:
                continue
            for name, test in self._fuzzy:
                if unit_norm and not unit_compatible(test, unit_norm):
                    continue
                score = similarity(candidate, name)
                if section_norm and normalise_name(test.section).split()[0] in section_norm:
                    score += SECTION_BOOST
                if score > scores.get(test.code, 0.0):
                    scores[test.code] = score
        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        if not ranked or ranked[0][1] < FUZZY_MIN:
            return None
        if len(ranked) > 1 and ranked[0][1] - ranked[1][1] < FUZZY_MARGIN:
            return None  # two tests are about equally likely: never guess
        return TestMatch(self.by_code[ranked[0][0]], min(ranked[0][1], 0.99), "fuzzy")


# ------------------------------------------------------------------ unit conversion


def to_canonical(test: LabTest, value: float, unit_norm: str) -> float | None:
    """The value in the test's canonical unit, or None when the printed unit is unknown/unusable."""
    if unit_norm == test.unit or (unit_norm in ("", "ratio") and test.unit in ("", "ratio")):
        return value
    conversion = test.conversions.get(unit_norm)
    if conversion is None:
        return None
    return value * conversion.factor + conversion.offset


def conversion_factor(test: LabTest, unit_norm: str) -> float | None:
    """Multiplier from the printed unit to the canonical one (None when an offset is involved)."""
    if unit_norm == test.unit:
        return 1.0
    conversion = test.conversions.get(unit_norm)
    if conversion is None or conversion.offset != 0.0:
        return None
    return conversion.factor


# ------------------------------------------------------------------ the whole report


# (field, max chars, max words, punctuation such as `;` `<` `>` allowed): text read from the page is DATA (M14 red team). A field that
# reads like an order to the assistant is dropped, so the row is treated as unreadable and never repeated.
_FIELD_LIMITS: tuple[tuple[str, int, int, bool], ...] = (
    ("raw_test_name", 70, 10, False),
    ("unit", 24, 4, False),
    ("value_raw", 24, 4, True),  # "<0.5", ">1000" are real values
    ("section", 50, 8, False),
    ("lab_ref_text", 120, 22, True),
)


def sanitise_result(result: LabResult) -> LabResult:
    update: dict[str, object] = {}
    for attribute, max_len, max_words, allow in _FIELD_LIMITS:
        field = getattr(result, attribute)
        text = field if isinstance(field, str) or field is None else field.value
        if looks_like_instruction(
            text, max_len=max_len, max_words=max_words, allow_punctuation=allow
        ):
            # `section` is a plain string, every other field is a {value, confidence} pair
            update[attribute] = (
                None if isinstance(field, str) else type(field)(value=None, confidence=0.0)
            )
    return result.model_copy(update=update) if update else result


def normalize_result(result: LabResult, index: LabIndex) -> LabResult:
    result = sanitise_result(result)
    name = result.raw_test_name.value or ""
    match = index.match(name, result.unit.value, result.section) if name else None
    parsed = parse_value(result.value_raw.value)
    update: dict[str, object] = {
        "test_code": match.test.code if match else None,
        "value_num": parsed.number,
        "value_comparator": parsed.comparator,
        "value_canonical": None,
        "unit_canonical": None,
    }
    if match is not None and parsed.kind == "numeric" and parsed.number is not None:
        canonical = to_canonical(match.test, parsed.number, normalise_unit(result.unit.value))
        if canonical is not None:
            update["value_canonical"] = canonical
            update["unit_canonical"] = match.test.unit
    return result.model_copy(update=update)


def normalize_report(extraction: LabReportExtraction, index: LabIndex) -> LabReportExtraction:
    return extraction.model_copy(
        update={"results": [normalize_result(r, index) for r in extraction.results]}
    )
