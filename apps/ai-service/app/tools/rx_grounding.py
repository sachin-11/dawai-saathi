"""The grounding verifier (M7, CLAUDE.md §2.5): deterministic checks on what the composer wrote.

The composer LLM may only rephrase structured data. After it answers, THIS module (no LLM) checks
each line against the data it was given:

  * there is exactly one line per readable medicine, with the same index, in order
  * the line contains the medicine's name (the user must see what the line is about)
  * every number in the line occurs in that medicine's own data (digits, and the number words
    once/twice/thrice); no number can come from anywhere else
  * every Latin-script word is either in that medicine's own data or in a small list of plain
    words for the language (so a drug name, a use or a warning that is not in the data is caught)
  * no "advice" phrases (stop, increase, side effect, ...)

Any problem returns a list of stable reason codes (never text from the reply) and the caller falls
back to the deterministic template renderer.
"""

import re
from collections.abc import Mapping, Sequence
from typing import Any, Final

from app.schemas.process import Language

MAX_ITEM_CHARS: Final = 200

_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
_LATIN_WORD = re.compile(r"[A-Za-z]+")

# Plain words each language's lines may use besides words from the medicine's own data.
_PLAIN_WORDS: Final[dict[Language, frozenset[str]]] = {
    Language.en: frozenset(
        {
            "tablet",
            "tablets",
            "capsule",
            "capsules",
            "syrup",
            "injection",
            "drop",
            "drops",
            "cream",
            "inhaler",
            "powder",
            "puff",
            "puffs",
            "take",
            "morning",
            "afternoon",
            "evening",
            "night",
            "before",
            "after",
            "with",
            "food",
            "for",
            "day",
            "days",
            "daily",
            "once",
            "twice",
            "thrice",
            "time",
            "times",
            "a",
            "as",
            "needed",
            "only",
            "when",
            "and",
            "at",
            "bedtime",
            "in",
            "the",
            "of",
            "mg",
            "mcg",
            "ml",
            "iu",
            "g",
        }
    ),
    Language.hi: frozenset({"mg", "mcg", "ml", "iu", "g"}),
}

_NUMBER_WORDS: Final[dict[str, int]] = {"once": 1, "twice": 2, "thrice": 3}

_ADVICE_PHRASES: Final[tuple[str, ...]] = (
    "side effect",
    "used for",
    "used to",
    "treat",
    "cure",
    "safe",
    "stop",
    "increase",
    "reduce",
    "skip",
    "avoid",
    "warning",
    "alternative",
    "generic",
    "doctor",
    "pharmacist",
    "दुष्प्रभाव",
    "इलाज",
    "बीमारी",
    "बंद",
    "बढ़ा",
    "घटा",
    "छोड़",
    "सुरक्षित",
    "ख़तरा",
    "खतरा",
    "डॉक्टर",
    "फ़ार्मासिस्ट",
    "फार्मासिस्ट",
)


def _normalise_digits(text: str) -> str:
    return text.translate(_DEVANAGARI_DIGITS)


def numbers_in(text: str) -> set[str]:
    """Every number written in `text` (Devanagari digits folded), `1,5` read as `1.5`."""
    return {_canonical(match) for match in _NUMBER.findall(_normalise_digits(text))}


def _canonical(number: str) -> str:
    """`1,50` -> `1.5`, `5.0` -> `5`, `650` -> `650`."""
    number = number.replace(",", ".")
    if "." in number:
        number = number.rstrip("0").rstrip(".")
    return number


def _strings_and_numbers(value: Any) -> tuple[list[str], list[str]]:
    """All text and all number-like values found anywhere inside `value`."""
    texts: list[str] = []
    numbers: list[str] = []
    if isinstance(value, bool) or value is None:
        return texts, numbers
    if isinstance(value, str):
        texts.append(value)
    elif isinstance(value, int | float):
        numbers.append(str(value))
    elif isinstance(value, Mapping):
        for item in value.values():
            t, n = _strings_and_numbers(item)
            texts += t
            numbers += n
    elif isinstance(value, Sequence):
        for item in value:
            t, n = _strings_and_numbers(item)
            texts += t
            numbers += n
    return texts, numbers


def allowed_numbers(medicine: Mapping[str, Any]) -> set[str]:
    texts, numbers = _strings_and_numbers({k: v for k, v in medicine.items() if k != "index"})
    allowed: set[str] = set()
    for text in texts:
        allowed |= numbers_in(text)
    for number in numbers:
        allowed |= numbers_in(number)
    return allowed


def allowed_words(medicine: Mapping[str, Any], language: Language) -> set[str]:
    texts, _ = _strings_and_numbers({k: v for k, v in medicine.items() if k != "index"})
    words = set(_PLAIN_WORDS[language])
    for text in texts:
        words |= {w.lower() for w in _LATIN_WORD.findall(text)}
    return words


def _squash(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", text.casefold())


def verify_item(
    index: int, text: str, medicine: Mapping[str, Any], language: Language
) -> list[str]:
    """Reason codes for ONE line; an empty list means the line is grounded."""
    problems: list[str] = []
    stripped = text.strip()
    if not stripped:
        return ["empty_line"]
    if len(stripped) > MAX_ITEM_CHARS:
        problems.append("line_too_long")
    if "\n" in stripped:
        problems.append("line_has_newline")

    name = medicine.get("name")
    if not isinstance(name, str) or _squash(name) not in _squash(stripped):
        problems.append("name_missing")

    allowed = allowed_numbers(medicine)
    if not numbers_in(stripped) <= allowed:
        problems.append("number_not_in_data")

    lowered_words = [w.lower() for w in _LATIN_WORD.findall(stripped)]
    for word in lowered_words:
        if word in _NUMBER_WORDS and str(_NUMBER_WORDS[word]) not in allowed:
            problems.append("number_word_not_in_data")
            break
    if not set(lowered_words) <= allowed_words(medicine, language):
        problems.append("unknown_word")

    folded = stripped.casefold()
    if any(phrase in folded for phrase in _ADVICE_PHRASES):
        problems.append("advice_phrase")
    return problems


def verify_items(
    items: Sequence[tuple[int, str]],
    medicines: Sequence[Mapping[str, Any]],
    language: Language,
) -> list[str]:
    """Reason codes for the whole composer answer (empty = every line is grounded)."""
    expected = [int(m["index"]) for m in medicines]
    got = [index for index, _ in items]
    if got != expected:
        return ["item_indexes_mismatch"]
    problems: list[str] = []
    by_index = {int(m["index"]): m for m in medicines}
    for index, text in items:
        problems += verify_item(index, text, by_index[index], language)
    return list(dict.fromkeys(problems))
