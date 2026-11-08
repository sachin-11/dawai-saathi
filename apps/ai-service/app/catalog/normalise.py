"""Normalisers for the medicine catalog and the matcher (M8). Pure functions, table-tested.

ONE implementation is used by the ingestion scripts (`data/scripts/`) and by the matcher, so a
catalog row and a prescription line end up with the SAME keys:

  salt_key      sorted, lowercase INN names joined by "+"            amlodipine+telmisartan
  strength_key  strengths aligned with the (sorted) salts, joined    5mg+40mg   |   125mg/5ml
  form_key      tablet | capsule | syrup | suspension | injection | drops | cream | gel | inhaler | other
  release_type  ir | sr | er | xr | cr | mr | dr | na

Generic suggestions need all four to be equal. Anything we cannot parse with certainty returns None
(or form "other"), never a guess. `form_key == "other"` is never substitutable.
"""

import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Final, Literal

from app.catalog.salt_aliases import (
    EXPLICIT_SALT_FORMS,
    HYDRATE_WORDS,
    SALT_ALIASES,
    SALT_FORM_SUFFIXES,
)
from app.catalog.translit import to_roman

FormKey = Literal[
    "tablet",
    "capsule",
    "syrup",
    "suspension",
    "injection",
    "drops",
    "cream",
    "gel",
    "inhaler",
    "other",
]
ReleaseType = Literal["ir", "sr", "er", "xr", "cr", "mr", "dr", "na"]

# ---------------------------------------------------------------- strength

_STRENGTH_RE: Final = re.compile(
    r"(?P<amt>\d+(?:[.,]\d+)?)\s*"
    r"(?P<unit>mcg|µg|μg|ug|mg|gm|g|i\.?u\.?|units?|ml|%)(?![a-z])"
    r"(?:\s*(?:/|per)\s*(?P<per_amt>\d+(?:\.\d+)?)?\s*(?P<per_unit>ml|gm|g|mg)(?![a-z]))?",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class Strength:
    amount: Decimal
    unit: str  # mcg | mg | iu | ml | %
    per_amount: Decimal | None = None
    per_unit: str | None = None

    def canon(self) -> str:
        text = f"{_fmt(self.amount)}{self.unit}"
        if self.per_unit is not None:
            text += f"/{_fmt(self.per_amount or Decimal(1))}{self.per_unit}"
        return text


def _fmt(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _strength_from_match(match: re.Match[str]) -> Strength | None:
    try:
        amount = Decimal(match.group("amt").replace(",", "."))
    except InvalidOperation:
        return None
    if amount <= 0:
        return None
    unit = match.group("unit").lower().replace(".", "")
    unit = {
        "µg": "mcg",
        "μg": "mcg",
        "ug": "mcg",
        "gm": "g",
        "iu": "iu",
        "unit": "iu",
        "units": "iu",
    }.get(unit, unit)
    per_unit = match.group("per_unit")
    per_amount = Decimal(match.group("per_amt")) if match.group("per_amt") else None
    per_unit = {"gm": "g"}.get(per_unit.lower(), per_unit.lower()) if per_unit else None
    if unit == "g":  # canonical mass unit is mg: 0.5 g -> 500 mg
        amount, unit = amount * 1000, "mg"
    if per_unit == "g" and per_amount is not None:
        per_amount, per_unit = per_amount * 1000, "mg"
    elif per_unit == "g":
        per_amount, per_unit = Decimal(1000), "mg"
    return Strength(amount, unit, per_amount if per_unit else None, per_unit)


def parse_strength(text: str | None) -> Strength | None:
    """`650mg`, `0.5 g`, `125 mg/5 ml`, `100 IU/ml`, `2%` -> Strength; None if there is no strength."""
    if not text:
        return None
    match = _STRENGTH_RE.search(unicodedata.normalize("NFKC", text))
    return _strength_from_match(match) if match else None


def find_strengths(text: str) -> list[tuple[Strength, tuple[int, int]]]:
    found: list[tuple[Strength, tuple[int, int]]] = []
    for match in _STRENGTH_RE.finditer(unicodedata.normalize("NFKC", text)):
        strength = _strength_from_match(match)
        if strength is not None:
            found.append((strength, match.span()))
    return found


def strength_canon(text: str | None) -> str | None:
    parsed = parse_strength(text)
    return parsed.canon() if parsed else None


def total_amount(strength_key: str | None) -> str | None:
    """`500mg+125mg` -> `625mg` (the way a prescription writes a combination's total); else None."""
    if not strength_key or "+" not in strength_key:
        return None
    total = Decimal(0)
    unit: str | None = None
    for part in strength_key.split("+"):
        parsed = parse_strength(part)
        if parsed is None or parsed.per_unit is not None or (unit and parsed.unit != unit):
            return None
        unit = parsed.unit
        total += parsed.amount
    return f"{_fmt(total)}{unit}" if unit else None


# ---------------------------------------------------------------- salts

_PHARMACOPOEIA = re.compile(r"\b(?:ip|bp|usp|nf|ph\.?\s*eur)\b\.?")
_PARENS = re.compile(r"\([^)]*\)")
_SPLIT = re.compile(r"\s*(?:\+|,|&|;|/|\band\b|\bwith\b)\s*")


def normalise_salt(raw: str) -> str | None:
    """One salt name -> canonical lowercase INN-ish name, or None if nothing is left."""
    stripped = raw.strip()
    if not stripped.isascii() and stripped in SALT_ALIASES:  # a Hindi spelling we know exactly
        return SALT_ALIASES[stripped]
    text = unicodedata.normalize("NFKC", to_roman(raw)).lower()
    text = _PARENS.sub(" ", text)
    text = _PHARMACOPOEIA.sub(" ", text)
    text = re.sub(r"[^a-z0-9 \-]", " ", text.lower())
    words = [w for w in text.replace("-", " ").split() if w and w not in HYDRATE_WORDS]
    while len(words) > 1 and words[-1] in SALT_FORM_SUFFIXES:
        words.pop()
    name = " ".join(words)
    if not name:
        return None
    name = EXPLICIT_SALT_FORMS.get(name, name)
    return SALT_ALIASES.get(name, name)


def split_salts(text: str) -> list[str]:
    """`Amoxycillin + Clavulanic Acid` -> ['amoxicillin', 'clavulanic acid'] (deduplicated, in order)."""
    names: list[str] = []
    for part in _SPLIT.split(text):
        salt = normalise_salt(part)
        if salt and salt not in names:
            names.append(salt)
    return names


def salt_key(salts: list[str]) -> str:
    return "+".join(sorted(salts))


def build_keys(pairs: list[tuple[str, Strength]]) -> tuple[str, str]:
    """`[(salt, Strength), ...]` -> (salt_key, strength_key) with strengths in sorted-salt order."""
    ordered = sorted(pairs, key=lambda pair: pair[0])
    return "+".join(s for s, _ in ordered), "+".join(st.canon() for _, st in ordered)


# ---------------------------------------------------------------- form + release

_RELEASE_PATTERNS: Final[tuple[tuple[str, ReleaseType], ...]] = (
    (r"\b(?:sr|s\.r\.|sustained[- ]release|prolonged[- ]release|retard)\b", "sr"),
    (r"\b(?:xr|xl|extended[- ]release)\b", "xr"),
    (r"\b(?:er|e\.r\.)\b", "er"),
    (r"\b(?:cr|controlled[- ]release|chrono)\b", "cr"),
    (r"\b(?:mr|modified[- ]release|depot)\b", "mr"),
    (r"\b(?:dr|delayed[- ]release|gastro[- ]?resistant|enteric[- ]coated)\b", "dr"),
)
_NOT_SUBSTITUTABLE_FORM = re.compile(
    r"\b(?:chewable|dispersible|orally disintegrating|odt|mouth dissolving|sublingual|effervescent|"
    r"lozenge|buccal|vaginal|pessary|suppository|patch|transdermal|nebuli[sz]er|respule|"
    r"eye|ear|nasal|ophthalmic|otic|lotion|ointment|solution|sachet|granules|powder|shampoo|spray)\b"
)
_FORM_PATTERNS: Final[tuple[tuple[str, FormKey], ...]] = (
    (r"\b(?:inhaler|rotacaps?|rotahaler|mdi|dpi|puffer|accuhaler)\b", "inhaler"),
    (r"\b(?:dry syrup|suspension|susp)\b", "suspension"),
    (r"\b(?:syrup|syp|oral solution|elixir|linctus)\b", "syrup"),
    (r"\b(?:injection|inj|infusion|vial|ampoule|ampule|prefilled|pen|cartridge)\b", "injection"),
    (r"\b(?:drops?)\b", "drops"),
    (r"\bcream\b", "cream"),
    (r"\bgel\b", "gel"),
    (r"\b(?:capsules?|caps?|softgel)\b", "capsule"),
    (r"\b(?:tablets?|tabs?|caplets?|film[- ]coated|f\.?c\.?)\b", "tablet"),
)


def parse_release(text: str) -> ReleaseType:
    lowered = text.lower()
    found = {code for pattern, code in _RELEASE_PATTERNS if re.search(pattern, lowered)}
    if not found:
        return "ir" if re.search(r"\b(?:tablets?|tabs?|capsules?|caps?)\b", lowered) else "na"
    # Conflicting words ("ER ... SR") cannot be trusted: treat as a generic modified release.
    return next(iter(found)) if len(found) == 1 else "mr"


def parse_form(text: str | None) -> tuple[FormKey, ReleaseType]:
    """`Film coated tablets` -> (tablet, ir); `Metformin SR tablet` -> (tablet, sr); unknown -> (other, na)."""
    if not text:
        return "other", "na"
    lowered = unicodedata.normalize("NFKC", to_roman(text)).lower()
    release = parse_release(lowered)
    if _NOT_SUBSTITUTABLE_FORM.search(lowered) and not re.search(r"\boral solution\b", lowered):
        return "other", release if release != "ir" else "na"
    for pattern, form in _FORM_PATTERNS:
        if re.search(pattern, lowered):
            if form in {"syrup", "suspension", "injection", "drops", "cream", "gel", "inhaler"}:
                return form, "na" if release == "ir" else release
            return form, release
    return "other", "na"


# ---------------------------------------------------------------- brand names

_BRAND_PREFIX = re.compile(
    r"^(?:tab|tablet|cap|capsule|syp|syrup|inj|injection|drops?|oint|ointment|susp)\b[.\s-]*"
)
_BRAND_SUFFIX = re.compile(r"[\s-]+(?:tab|tablets?|caps?|capsules?|syp|syrup|inj|injection)\.?$")


def brand_key(name: str) -> str:
    """`Tab. Dolo-650` / `DOLO 650 TAB` / `डोलो 650` -> `dolo650`. Lookup key for brand matching."""
    text = unicodedata.normalize("NFKC", to_roman(name)).lower().strip()
    text = _BRAND_PREFIX.sub("", text)
    text = _BRAND_SUFFIX.sub("", text)
    return re.sub(r"[^a-z0-9]", "", text)


# ---------------------------------------------------------------- product names (Jan Aushadhi style)


@dataclass(frozen=True, slots=True)
class ParsedProduct:
    salt_key: str
    strength_key: str
    form_key: FormKey
    release_type: ReleaseType
    salts: tuple[str, ...]


def parse_product_name(name: str) -> ParsedProduct | None:
    """`Amoxycillin 500mg + Clavulanic Acid 125mg Tablets` -> keys; None when it cannot be done safely.

    The strengths must pair one-to-one with the salts, in order. One strength for several salts, or no
    strength at all, is rejected (an ingestion report lists the reason), never guessed.
    """
    text = unicodedata.normalize("NFKC", name)
    strengths = find_strengths(text)
    if not strengths:
        return None
    form, release = parse_form(text)
    composition = text
    for _, (start, end) in sorted(strengths, key=lambda item: -item[1][0]):
        composition = composition[:start] + " + " + composition[end:]
    composition = re.sub(r"\b[wv]\s*/\s*[wv]\b", " ", composition, flags=re.IGNORECASE)  # w/w, w/v
    composition = re.sub(
        r"\b(?:tablets?|tabs?|capsules?|caps?|syrup|oral suspension|oral solution|suspension|injection|"
        r"drops?|cream|gel|inhaler|chewable|dispersible|effervescent|sublingual|orally|"
        r"disintegrating|soft|gelatin|film[- ]coated|gastro[- ]?resistant|sustained[- ]release|"
        r"extended[- ]release|prolonged[- ]release|modified[- ]release|controlled[- ]release|"
        r"delayed[- ]release|enteric[- ]coated|dry|sr|xr|xl|er|cr|mr|dr)\b",
        " ",
        composition,
        flags=re.IGNORECASE,
    )
    salts = split_salts(composition)
    if not salts or len(salts) != len(strengths):
        return None
    pairs = list(zip(salts, [s for s, _ in strengths], strict=True))
    key, strength = build_keys(pairs)
    return ParsedProduct(key, strength, form, release, tuple(sorted(salts)))
