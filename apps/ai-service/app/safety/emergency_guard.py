"""Emergency guard (M6, CLAUDE.md §2.2): never miss an emergency, answer instantly.

Two stages, both biased towards RECALL (a needless "call 112" is cheap, a missed emergency is not):

  1. Rules (always runs, a few ms): the shared phrase list `data/emergency-keywords.json` (the same
     file the gateway pre-check reads) matched on normalised text, with up to two filler words
     allowed inside a phrase ("seene me BAHUT dard") and fuzzy matching (edit distance <= 1, words
     of 5+ letters) for typing mistakes.
  2. Classifier (only when the rules did not match and the text is not trivially short): the CHEAP
     model with prompt `emergency_classify_v1`. Emergency if `is_emergency` and confidence >=
     EMERGENCY_MIN_CONFIDENCE (default 0.5, deliberately low).

Fail-safe: if the classifier times out or errors, the rules alone decide and the request goes on;
the guard never blocks a request and never raises.

SCOPE: the guard applies to text the USER wrote (and, from M13, voice transcripts). It must NEVER be
given text extracted from a prescription or lab-report image: a report that says "chest pain" is
history, not an emergency. The type system enforces it: `check*` accept `UserText` only, and
`user_text_from_request` returns None for image input.

No matched text is ever logged: results carry a category and a count.
"""

import asyncio
import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Final, Literal, NewType

import structlog
from pydantic import BaseModel, Field

from app.config import Settings
from app.llm.router import Deadline, LLMRouter
from app.llm.types import Message
from app.prompts.registry import PromptRegistry
from app.schemas.process import EmergencyCategory, InputType, ProcessRequest

if TYPE_CHECKING:
    from app.pipeline.base import RequestUsage

_log = structlog.get_logger("emergency_guard")

KEYWORDS_PATH: Final = Path(__file__).parent / "data" / "emergency-keywords.json"
CLASSIFIER_PROMPT_ID: Final = "emergency_classify_v1"
MAX_PHRASE_GAP: Final = 2
FUZZY_MIN_LENGTH: Final = 5
# Trivially short: a single short word ("hi", "ok", "help") is not worth an LLM call.
CLASSIFIER_MIN_CHARS: Final = 8

# Text the USER wrote. Create it only from the user's own message (see `user_text_from_request`).
UserText = NewType("UserText", str)

EmergencyKind = Literal["general", "self_harm"]
EmergencySource = Literal["rules", "classifier"]
ClassifierStatus = Literal["not_needed", "skipped_short", "ran", "unavailable"]


@dataclass(frozen=True, slots=True)
class EmergencyResult:
    is_emergency: bool
    category: EmergencyCategory | None = None
    source: EmergencySource | None = None
    matched_terms_count: int = 0
    classifier_status: ClassifierStatus = "not_needed"

    @property
    def kind(self) -> EmergencyKind | None:
        if not self.is_emergency:
            return None
        return "self_harm" if self.category is EmergencyCategory.self_harm else "general"


class EmergencyClassification(BaseModel):
    """Structured output of the classifier stage."""

    is_emergency: bool
    category: EmergencyCategory | None = None
    confidence: float = Field(ge=0.0, le=1.0)


def user_text_from_request(request: ProcessRequest) -> UserText | None:
    """The only way the pipeline creates a `UserText`: the user's own typed message.

    Images (and their extracted text) yield None, so the guard cannot run on them. Audio joins in
    M13 once there is a transcript of what the user said.
    """
    if request.input.type is InputType.text and request.input.text:
        return UserText(request.input.text)
    return None


# ---------------------------------------------------------------------------- normalisation


def normalise_for_emergency(text: str) -> str:
    """Same function as the gateway's `normaliseForEmergency` (shared test vectors keep them equal):
    lower-case, Devanagari nukta/candrabindu folded, invisible characters dropped, anything that is
    not a letter/number/mark becomes a space, whitespace collapsed, repeated Latin letters squeezed
    ("dardddd" -> "dard"; vowels keep at most two)."""
    folded = unicodedata.normalize("NFD", text).lower()
    kept: list[str] = []
    for char in folded:
        category = unicodedata.category(char)
        if category == "Cf" or char == "़":
            continue
        if char == "ँ":
            char = "ं"
        kept.append(char)
    composed = unicodedata.normalize("NFC", "".join(kept))
    cleaned = "".join(
        char if char.isspace() or unicodedata.category(char)[0] in {"L", "N", "M"} else " "
        for char in composed
    )
    collapsed = " ".join(cleaned.split())
    collapsed = re.sub(r"([b-df-hj-np-tv-z])\1+", r"\1", collapsed)
    return re.sub(r"([aeiou])\1{2,}", r"\1\1", collapsed)


# Ordinary words one edit away from a keyword token: matching them would be noise, not safety.
# Written naturally and normalised like everything else ("stroll" becomes "strol").
_FUZZY_BLOCKLIST: Final = frozenset(
    normalise_for_emergency(word)
    for word in (
        "painted",
        "strike",
        "strikes",
        "striker",
        "stroll",
        "stroller",
        "stoke",
        "poised",
        "poisson",
        "stroked",
    )
)


# ---------------------------------------------------------------------------- keyword index


def _is_latin_token(token: str) -> bool:
    return bool(re.match(r"[a-z0-9]", token))


def osa_distance(a: str, b: str) -> int:
    """Optimal string alignment distance (edit distance where swapping two neighbours costs 1)."""
    rows, cols = len(a) + 1, len(b) + 1
    table = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        table[i][0] = i
    for j in range(cols):
        table[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            table[i][j] = min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                table[i][j] = min(table[i][j], table[i - 2][j - 2] + 1)
    return table[-1][-1]


@dataclass(frozen=True, slots=True)
class _Phrase:
    category: EmergencyCategory
    tokens: tuple[str, ...]
    latin: tuple[bool, ...]


class KeywordIndex:
    """The shared keyword file, compiled for fast matching."""

    def __init__(self, data: dict[str, object]) -> None:
        self.version = str(data["version"])
        categories = data["categories"]
        if not isinstance(categories, dict):
            raise ValueError("emergency keywords: 'categories' must be an object")
        self.phrases: list[_Phrase] = []
        seen: set[tuple[str, tuple[str, ...]]] = set()
        for name, raw in categories.items():
            category = EmergencyCategory(name)
            for language in ("en", "hi", "hinglish", "misspellings"):
                for phrase in raw[language]:
                    normalised = normalise_for_emergency(phrase)
                    if not normalised:
                        continue
                    tokens = tuple(normalised.split(" "))
                    if (name, tokens) in seen:
                        continue
                    seen.add((name, tokens))
                    self.phrases.append(
                        _Phrase(category, tokens, tuple(_is_latin_token(t) for t in tokens))
                    )
        # Self-harm first: it adds Tele-MANAS 14416 to the reply.
        self.phrases.sort(key=lambda p: p.category is not EmergencyCategory.self_harm)

        # first token -> phrases starting with it (exact Latin) / Devanagari prefix list
        self._by_first: dict[str, list[_Phrase]] = {}
        self._devanagari_first: list[tuple[str, _Phrase]] = []
        vocab: set[str] = set()
        for phrase in self.phrases:
            if phrase.latin[0]:
                self._by_first.setdefault(phrase.tokens[0], []).append(phrase)
            else:
                self._devanagari_first.append((phrase.tokens[0], phrase))
            vocab.update(
                token
                for token, latin in zip(phrase.tokens, phrase.latin, strict=True)
                if latin and len(token) >= FUZZY_MIN_LENGTH
            )
        self._vocab = frozenset(vocab)
        # single-deletion variants of every fuzzy-eligible token, for one-edit lookups
        self._deletions: dict[str, set[str]] = {}
        for token in vocab:
            for variant in self._deletes(token):
                self._deletions.setdefault(variant, set()).add(token)

    @staticmethod
    def _deletes(word: str) -> set[str]:
        return {word[:i] + word[i + 1 :] for i in range(len(word))}

    def variants(self, word: str) -> frozenset[str]:
        """The keyword tokens this typed word may stand for: itself, plus one-edit neighbours."""
        found = {word}
        if len(word) < FUZZY_MIN_LENGTH or word in _FUZZY_BLOCKLIST:
            return frozenset(found)
        candidates: set[str] = set()
        deletes = self._deletes(word)
        candidates.update(deletes & self._vocab)  # the word has one extra letter
        candidates.update(self._deletions.get(word, ()))  # the word misses one letter
        for variant in deletes:  # one substituted letter
            candidates.update(self._deletions.get(variant, ()))
        for i in range(len(word) - 1):  # two neighbours swapped
            swapped = word[:i] + word[i + 1] + word[i] + word[i + 2 :]
            if swapped in self._vocab:
                candidates.add(swapped)
        found.update(c for c in candidates if osa_distance(word, c) <= 1)
        return frozenset(found)

    def match(self, normalised: str) -> list[_Phrase]:
        """Every phrase found in the (already normalised) text."""
        words = normalised.split(" ")
        cache: dict[int, frozenset[str]] = {}

        def variants_at(index: int) -> frozenset[str]:
            if index not in cache:
                cache[index] = self.variants(words[index])
            return cache[index]

        def token_matches(index: int, token: str, latin: bool) -> bool:
            return token in variants_at(index) if latin else words[index].startswith(token)

        matched: list[_Phrase] = []
        for start in range(len(words)):
            candidates: list[_Phrase] = []
            for variant in variants_at(start):
                candidates.extend(self._by_first.get(variant, ()))
            candidates.extend(
                phrase for token, phrase in self._devanagari_first if words[start].startswith(token)
            )
            for phrase in candidates:
                if phrase in matched:
                    continue
                position, count = start, 1
                while count < len(phrase.tokens):
                    nxt = next(
                        (
                            n
                            for n in range(
                                position + 1, min(len(words), position + 2 + MAX_PHRASE_GAP)
                            )
                            if token_matches(n, phrase.tokens[count], phrase.latin[count])
                        ),
                        None,
                    )
                    if nxt is None:
                        break
                    position, count = nxt, count + 1
                if count == len(phrase.tokens):
                    matched.append(phrase)
        return matched


@lru_cache(maxsize=1)
def load_keyword_index() -> KeywordIndex:
    """Load the bundled copy of the shared keyword file (fails fast when it is missing/invalid)."""
    return KeywordIndex(json.loads(KEYWORDS_PATH.read_text(encoding="utf-8")))


# ---------------------------------------------------------------------------- the guard


class EmergencyGuard:
    def __init__(self, index: KeywordIndex | None = None) -> None:
        self._index = index or load_keyword_index()

    # ---- stage 1
    def check_rules(self, text: UserText) -> EmergencyResult:
        """Stage 1 only. Pure and fast; never raises on odd input."""
        normalised = normalise_for_emergency(text)
        if not normalised:
            return EmergencyResult(is_emergency=False)
        matched = self._index.match(normalised)
        if not matched:
            return EmergencyResult(is_emergency=False)
        return EmergencyResult(
            is_emergency=True,
            category=next(
                (p.category for p in matched if p.category is EmergencyCategory.self_harm),
                matched[0].category,
            ),  # self_harm always wins: it adds Tele-MANAS 14416 to the reply
            source="rules",
            matched_terms_count=len(matched),
        )

    # ---- stage 2
    async def classify(
        self,
        classifier_text: str,
        *,
        router: LLMRouter,
        prompts: PromptRegistry,
        settings: Settings,
        usage: "RequestUsage",
    ) -> EmergencyResult:
        """Stage 2. `classifier_text` should be the REDACTED text: it is sent to an LLM provider."""
        if len(normalise_for_emergency(classifier_text)) < CLASSIFIER_MIN_CHARS:
            return EmergencyResult(is_emergency=False, classifier_status="skipped_short")
        try:
            prompt = prompts.load(CLASSIFIER_PROMPT_ID)
            messages = [
                prompt.to_message(),
                Message("user", f"<message>\n{classifier_text}\n</message>"),
            ]
            async with asyncio.timeout(settings.emergency_classifier_timeout_s):
                result = await router.generate(
                    prompt.model_role,
                    messages,
                    name="emergency_classify",
                    temperature=prompt.temperature,
                    max_tokens=80,
                    response_model=EmergencyClassification,
                    prompt_version=prompt.version,
                    deadline=Deadline(settings.emergency_classifier_timeout_s),
                )
            usage.add(result, prompt.version)
            parsed = result.parsed
            if not isinstance(parsed, EmergencyClassification):
                raise TypeError("classifier returned an unexpected shape")
        except Exception as error:
            _log.warning("emergency_classifier_unavailable", error_type=type(error).__name__)
            return EmergencyResult(is_emergency=False, classifier_status="unavailable")

        if parsed.is_emergency and parsed.confidence >= settings.emergency_min_confidence:
            return EmergencyResult(
                is_emergency=True,
                category=parsed.category,
                source="classifier",
                classifier_status="ran",
            )
        return EmergencyResult(is_emergency=False, classifier_status="ran")

    # ---- both stages
    async def check(
        self,
        text: UserText,
        *,
        router: LLMRouter,
        prompts: PromptRegistry,
        settings: Settings,
        usage: "RequestUsage",
        classifier_text: str | None = None,
    ) -> EmergencyResult:
        """Rules, then (only if they did not match) the classifier."""
        by_rules = self.check_rules(text)
        if by_rules.is_emergency:
            return by_rules
        return await self.classify(
            classifier_text if classifier_text is not None else text,
            router=router,
            prompts=prompts,
            settings=settings,
            usage=usage,
        )
