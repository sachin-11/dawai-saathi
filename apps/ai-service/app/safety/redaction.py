"""PHI redaction: Microsoft Presidio + Indian recognisers (M6, CLAUDE.md §2.6, §12).

Where it is used (everything that could leave the process or reach a log):
  * the pipeline: the text given to the intent / emergency classifier is the redacted text
  * structlog: any log field named text / body / prompt / output (see `observability/logging.py`)
  * Langfuse: every input, output and metadata value (see `observability/tracing.py`)

Design points
  * The Presidio engines (and the spaCy model) are built ONCE and cached; the app warms them up in
    its lifespan so the first request does not pay for it and a missing model fails the boot.
  * Entities are an explicit allow-list. Presidio's generic recognisers (DATE_TIME, LOCATION, ...)
    are NOT used, because they would redact medical content (doses, dates of a prescription,
    lab values). Strengths ("500 mg"), schedules ("1-0-1", "BD") and lab values ("HbA1c 7.2") are
    never entities.
  * spaCy's PERSON labels are only trusted next to a context word (Mr, Dr, patient name, naam ...).
    Without that gate the small English model labels drug names such as "Metformin" as people.
  * Fail closed: if the engines are unavailable or raise, a plain regex layer still removes phone
    numbers, Aadhaar-like numbers, e-mails and PIN codes (it over-redacts on purpose).

Known limits (be honest in reviews): person names are the weak spot. Names typed in Hindi or Roman
script WITHOUT a context word ("Ramesh ko bukhar hai") are not recognised, and spaCy's English model
knows few Indian names. Addresses are only caught through PIN codes and context words.
"""

import re
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Final

import structlog
from presidio_analyzer import (
    AnalyzerEngine,
    EntityRecognizer,
    RecognizerRegistry,
    RecognizerResult,
)
from presidio_analyzer.nlp_engine import NlpArtifacts, NlpEngineProvider
from presidio_analyzer.predefined_recognizers import SpacyRecognizer
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

_log = structlog.get_logger("redaction")

SPACY_MODEL: Final = "en_core_web_sm"
SCORE_THRESHOLD: Final = 0.4

PHONE: Final = "IN_PHONE"
AADHAAR: Final = "IN_AADHAAR"
PAN: Final = "IN_PAN"
ABHA: Final = "IN_ABHA"
PIN: Final = "IN_PIN"
EMAIL: Final = "EMAIL_ADDRESS"
URL: Final = "URL"
HOSPITAL_ID: Final = "HOSPITAL_ID"
PERSON: Final = "PERSON"

PLACEHOLDERS: Final[dict[str, str]] = {
    PHONE: "[PHONE]",
    AADHAAR: "[AADHAAR]",
    PAN: "[PAN]",
    ABHA: "[ABHA]",
    PIN: "[PIN]",
    EMAIL: "[EMAIL]",
    URL: "[URL]",
    HOSPITAL_ID: "[HOSPITAL_ID]",
    PERSON: "[NAME]",
}


@dataclass(frozen=True, slots=True)
class EntityCount:
    type: str
    count: int


@dataclass(frozen=True, slots=True)
class RedactionResult:
    """The redacted text and WHAT was removed (types and counts only, never the values)."""

    text: str
    entities: list[EntityCount] = field(default_factory=list)


# ---------------------------------------------------------------------------- checksums


_VERHOEFF_D: Final = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)
_VERHOEFF_P: Final = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)


def verhoeff_valid(number: str) -> bool:
    """Verhoeff checksum, the one Aadhaar numbers carry in their last digit."""
    digits = [int(char) for char in number if char.isdigit()]
    if not digits:
        return False
    check = 0
    for index, digit in enumerate(reversed(digits)):
        check = _VERHOEFF_D[check][_VERHOEFF_P[index % 8][digit]]
    return check == 0


# ---------------------------------------------------------------------------- name helpers

_TITLES: Final = (
    r"mr|mrs|ms|miss|shri|shree|sri|smt|shrimati|dr|prof|"
    r"श्री|श्रीमती|श्रीमान|सुश्री|डॉ|डॉक्टर|प्रो"
)
# Words that end a name ("Dr Sharma NE kaha"). Lower-case only: names after a title are matched
# until the first of these, or until the capitalisation pattern breaks.
_NAME_STOPWORDS: Final = frozenset(
    {
        "ne", "ko", "se", "ka", "ki", "ke", "me", "mein", "hai", "he", "hain", "ho", "tha", "thi",
        "kya", "aur", "and", "or", "is", "was", "the", "has", "had", "said", "says", "told",
        "prescribed", "advised", "gave", "wrote", "bola", "bataya", "kaha", "diya", "di", "likha",
        "ji", "sir", "madam", "for", "to", "of", "in", "on", "at", "with", "from",
        "ने", "को", "से", "का", "की", "के", "में", "है", "हैं", "था", "थी", "और", "जी",
    }
)  # fmt: skip

# Words that make a following spaCy PERSON hit trustworthy.
_PERSON_CONTEXT_WORDS: Final = frozenset(
    {
        "mr", "mrs", "ms", "miss", "shri", "shree", "sri", "smt", "shrimati", "dr", "prof",
        "naam", "name", "patient", "mareez", "मरीज", "नाम", "श्री", "श्रीमती", "डॉ", "डॉक्टर",
    }
)  # fmt: skip

_WORD = r"[A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F.']*"
_NAME_TAIL = rf"({_WORD}(?:\s+{_WORD}){{0,2}})"


def _trim_name(raw: str) -> tuple[int, int] | None:
    """Which part of the words after a title is the name? Returns (start, end) inside `raw`."""
    words = list(re.finditer(_WORD, raw))
    if not words:
        return None
    first = words[0].group().rstrip(".")
    capitalised = first[:1].isupper()
    kept = 0
    for index, match in enumerate(words):
        word = match.group().rstrip(".'")
        if word.lower() in _NAME_STOPWORDS or len(word) < 2:
            break
        if index > 0 and capitalised and not word[:1].isupper():
            break
        if index >= 3:
            break
        kept = index + 1
    if kept == 0:
        return None
    return words[0].start(), words[kept - 1].end()


# ---------------------------------------------------------------------------- recognisers


class _PatternRecognizer(EntityRecognizer):
    """A deterministic regex recogniser that can mark only one GROUP of the match (so the context
    words stay readable) and can score matches with a callback (checksums)."""

    def __init__(
        self,
        entity: str,
        pattern: str,
        score: float,
        *,
        group: int = 0,
        scorer: Callable[[str], float] | None = None,
        trim: bool = False,
    ) -> None:
        super().__init__(
            supported_entities=[entity],
            name=f"{entity}_pattern",
            supported_language="en",
        )
        self._entity = entity
        self._regex = re.compile(pattern, re.IGNORECASE)
        self._score = score
        self._group = group
        self._scorer = scorer
        self._trim = trim

    def load(self) -> None:  # nothing to load
        return None

    def analyze(
        self,
        text: str,
        entities: list[str],
        nlp_artifacts: NlpArtifacts | None = None,
    ) -> list[RecognizerResult]:
        results: list[RecognizerResult] = []
        for match in self._regex.finditer(text):
            start, end = match.span(self._group)
            if start < 0 or end <= start:
                continue
            if self._trim:
                trimmed = _trim_name(text[start:end])
                if trimmed is None:
                    continue
                start, end = start + trimmed[0], start + trimmed[1]
            score = self._scorer(match.group(self._group)) if self._scorer else self._score
            results.append(
                RecognizerResult(entity_type=self._entity, start=start, end=end, score=score)
            )
        return results


def _aadhaar_score(value: str) -> float:
    # Any 12-digit number in the Aadhaar shape is redacted; a valid checksum makes it certain.
    return 0.95 if verhoeff_valid(value) else 0.5


def _build_recognisers() -> list[EntityRecognizer]:
    return [
        # Indian mobile: optional +91 / 91 / 0091 / 0, then 10 digits starting 6-9; split 5+5,
        # or 4+3+3 (98765 43210 / 9876 543 210), with spaces or dashes, or none.
        _PatternRecognizer(
            PHONE,
            r"(?<![\w.])(?:(?:\+|00)?91[\s-]?|0)?"
            r"(?:[6-9]\d{4}[\s-]?\d{5}|[6-9]\d{3}[\s-]?\d{3}[\s-]?\d{3})(?!\d)",
            0.85,
        ),
        # Aadhaar-like: 12 digits, XXXX XXXX XXXX or plain, first digit 2-9.
        _PatternRecognizer(
            AADHAAR, r"(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)", 0.5, scorer=_aadhaar_score
        ),
        _PatternRecognizer(PAN, r"(?<![A-Za-z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Za-z0-9])", 0.9),
        # ABHA number: 14 digits, XX-XXXX-XXXX-XXXX.
        _PatternRecognizer(ABHA, r"(?<!\d)\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)", 0.85),
        # PIN code: 6 digits (not starting with 0) ONLY after a context word, otherwise lab values
        # such as "platelets 150000" would be redacted.
        _PatternRecognizer(
            PIN,
            r"(?:\bpin(?:[\s-]?code)?|\bzip|\baddress|\bpata|पिन(?:[\s-]?कोड)?|पता)"
            r"[^\d\n]{0,60}?(?<!\d)([1-9]\d{5})(?!\d)",
            0.6,
            group=1,
        ),
        _PatternRecognizer(
            EMAIL,
            r"(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}",
            0.95,
        ),
        # URLs that carry a query string (tokens, ids); plain links are not personal data.
        _PatternRecognizer(URL, r"https?://[^\s<>\"']+\?[^\s<>\"']+", 0.8),
        # Hospital identifiers: the id after UHID / MRN / Reg No / IP No / OP No.
        _PatternRecognizer(
            HOSPITAL_ID,
            r"\b(?:uhid|mrn|reg(?:istration)?\.?\s*(?:no|number)\.?|[io]p\.?\s*(?:no|number)\.?)"
            r"\s*[:#\-]?\s*([A-Z0-9][A-Z0-9/\-]{3,})",
            0.85,
            group=1,
        ),
        # Person names introduced by a title ("Dr Sharma", "Smt. Sunita Devi", "श्री रमेश").
        _PatternRecognizer(
            PERSON,
            rf"(?<![A-Za-z\u0900-\u097F])(?:{_TITLES})\.?\s+{_NAME_TAIL}",
            0.85,
            group=1,
            trim=True,
        ),
        # ...and by "my name is", "patient name", "mera naam", "naam:".
        _PatternRecognizer(
            PERSON,
            r"(?:\bmy\s+name\s+is|\bpatient(?:'s)?\s+name|\bmera\s+naam|\bmeri\s+naam|"
            r"\bpatient\s+ka\s+naam|\bmareez\s+ka\s+naam|\bnaam\s*:|मेरा\s+नाम|मरीज़?\s+का\s+नाम)"
            rf"[\s:\-]*(?:is\s+|hai\s+|है\s+)?{_NAME_TAIL}",
            0.85,
            group=1,
            trim=True,
        ),
    ]


class _ContextGatedSpacyPerson(SpacyRecognizer):
    """spaCy's PERSON labels, kept only next to a context word (it tags "Metformin" as a person).

    The gate sits inside the recogniser, before Presidio merges overlapping results; gating
    afterwards would drop a real name whenever a spaCy span happens to swallow a rule match."""

    def analyze(
        self,
        text: str,
        entities: list[str],
        nlp_artifacts: NlpArtifacts | None = None,
    ) -> list[RecognizerResult]:
        results: list[RecognizerResult] = super().analyze(text, entities, nlp_artifacts)
        trimmed: list[RecognizerResult] = []
        for result in results:
            if not _has_person_context(text, result.start):
                continue
            # The same stop-word trimming as the rule recognisers ("ramesh kumar HAI", "KA parcha").
            inner = _trim_name(text[result.start : result.end])
            if inner is None:
                continue
            trimmed.append(
                RecognizerResult(
                    entity_type=result.entity_type,
                    start=result.start + inner[0],
                    end=result.start + inner[1],
                    score=result.score,
                )
            )
        return trimmed


# ---------------------------------------------------------------------------- engines


@dataclass(frozen=True, slots=True)
class _Engines:
    analyzer: AnalyzerEngine
    anonymizer: AnonymizerEngine


@lru_cache(maxsize=1)
def _build_engines() -> _Engines:
    """Build Presidio + spaCy once per process (about 2 s). Raises if the model is missing."""
    import logging

    logging.getLogger("presidio-analyzer").setLevel(logging.ERROR)
    logging.getLogger("presidio-anonymizer").setLevel(logging.ERROR)

    provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": SPACY_MODEL}],
        }
    )
    registry = RecognizerRegistry(supported_languages=["en"])
    # No predefined recognisers: only ours plus spaCy's PERSON (gated by context, see `Redactor`).
    for recogniser in _build_recognisers():
        registry.add_recognizer(recogniser)
    registry.add_recognizer(
        _ContextGatedSpacyPerson(supported_entities=[PERSON], supported_language="en")
    )
    analyzer = AnalyzerEngine(
        registry=registry, nlp_engine=provider.create_engine(), supported_languages=["en"]
    )
    anonymizer = AnonymizerEngine()  # type: ignore[no-untyped-call]
    return _Engines(analyzer=analyzer, anonymizer=anonymizer)


# ---------------------------------------------------------------------------- fail-closed layer

_FALLBACK_RULES: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (
        re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"),
        PLACEHOLDERS[EMAIL],
    ),
    (re.compile(r"(?<!\w)(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)"), PLACEHOLDERS[PHONE]),
    (re.compile(r"(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)"), PLACEHOLDERS[AADHAAR]),
    # Over-redacts any standalone 6-digit number: acceptable only while the engines are down.
    (re.compile(r"(?<!\d)[1-9]\d{5}(?!\d)"), PLACEHOLDERS[PIN]),
)


def _fallback_redact(text: str) -> RedactionResult:
    counts: Counter[str] = Counter()
    for pattern, placeholder in _FALLBACK_RULES:
        text, hits = pattern.subn(placeholder, text)
        if hits:
            counts[placeholder] += hits
    return RedactionResult(
        text=text, entities=[EntityCount(type=name, count=count) for name, count in counts.items()]
    )


# ---------------------------------------------------------------------------- the redactor


def _has_person_context(text: str, start: int) -> bool:
    """Is one of the three words before `start` a title / "name" word?"""
    before = re.findall(r"[^\s.,:;()\[\]]+", text[:start].lower())[-3:]
    return any(word.strip(".'") in _PERSON_CONTEXT_WORDS for word in before)


class Redactor:
    def __init__(self, *, enabled: bool = True) -> None:
        self.enabled = enabled

    def warm_up(self) -> None:
        """Build the engines now (app startup). Raises when Presidio or the spaCy model is unusable."""
        if self.enabled:
            _build_engines()

    def redact(self, text: str) -> RedactionResult:
        if not self.enabled or not text.strip():
            return RedactionResult(text=text)
        try:
            return self._redact_with_presidio(text)
        except Exception as error:
            # Only the exception type: its message could contain the text.
            _log.error("redaction_engine_failed", error_type=type(error).__name__)
            return _fallback_redact(text)

    def _redact_with_presidio(self, text: str) -> RedactionResult:
        engines = _build_engines()
        found = engines.analyzer.analyze(
            text=unicodedata.normalize("NFC", text),
            language="en",
            entities=list(PLACEHOLDERS),
            score_threshold=SCORE_THRESHOLD,
        )
        normalised = unicodedata.normalize("NFC", text)
        kept = found
        if not kept:
            return RedactionResult(text=text)
        operators = {
            entity: OperatorConfig("replace", {"new_value": placeholder})
            for entity, placeholder in PLACEHOLDERS.items()
        }
        anonymised = engines.anonymizer.anonymize(
            text=normalised,
            analyzer_results=kept,  # type: ignore[arg-type]
            operators=operators,
        )
        counts = Counter(item.entity_type for item in anonymised.items)
        return RedactionResult(
            text=anonymised.text,
            entities=[
                EntityCount(type=name, count=count) for name, count in sorted(counts.items())
            ],
        )


# ---------------------------------------------------------------------------- module-level API

_active: Redactor = Redactor()


def configure_redactor(redactor: Redactor) -> None:
    """Install the process-wide redactor (the app does this at startup from `REDACTION_ENABLED`)."""
    global _active
    _active = redactor


def get_redactor() -> Redactor:
    return _active


def redact_text(text: str) -> RedactionResult:
    """Redact one text with the process-wide redactor. `.text` is the safe version."""
    return _active.redact(text)


def redact_str(text: str) -> str:
    """`redact_text(text).text`, for callers that only need the string (logs, traces)."""
    return _active.redact(text).text


def redact_value(value: Any, *, _depth: int = 0) -> Any:
    """Redact every string inside nested dicts/lists/tuples (used before data leaves the process)."""
    if _depth > 8:
        return "[REDACTED_DEEP]"
    if isinstance(value, str):
        return redact_str(value)
    if isinstance(value, dict):
        return {key: redact_value(item, _depth=_depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_value(item, _depth=_depth + 1) for item in value]
    return value
