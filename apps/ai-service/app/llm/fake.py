"""Deterministic, offline LLM provider for tests and `LLM_MODE=fake`.

It never touches the network, always answers the same way for the same input, and can be scripted
(canned answers or errors) or driven by a JSON fixture file. In fake mode without a script it falls
back to a keyword heuristic for the one structured task that exists in M5: intent classification.
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from app.llm.fake_rx import (
    SAMPLE_CLASSIFICATION,
    SAMPLE_EXTRACTION,
    SAMPLE_LAB_EXTRACTION,
    fake_compose,
)
from app.llm.types import ImageInput, LLMError, Message, RawResult

FAKE_MODEL = "fake-model"

# Lower-case keywords per intent (prompt `intent_text_v2`) for the default heuristic. First match wins;
# anything else is out_of_scope, exactly like the real prompt.
_INTENT_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "help",
        (
            "help",
            "madad",
            "मदद",
            "kya kar sakte",
            "kya kar sakti",
            "kya karte ho",
            "what can you do",
            "how do you work",
            "how does this work",
        ),
    ),
    ("lab_question", ("lab report", "blood test", "report", "रिपोर्ट", "hba1c", "tsh")),
    (
        "interaction_query",
        (
            "interaction",
            "saath me le sakta",
            "together safe",
            "saath le sak",
            "take together",
            "saath lena",
            "ek saath",
        ),
    ),
    ("generic_query", ("generic", "sasta", "cheaper", "alternative")),
    (
        "prescription_question",
        (
            "prescription",
            "parcha",
            "parche",
            "पर्ची",
            "dawai",
            "dawa ",
            "medicine",
            "tablet",
            "goli",
        ),
    ),
)
_GREETING_WORDS = frozenset(
    {
        "hi",
        "hii",
        "hello",
        "hey",
        "namaste",
        "namaskar",
        "thanks",
        "thank",
        "you",
        "dhanyavad",
        "नमस्ते",
    }
)
# Phrases a real model would flag even though the keyword rules do not list them. They let the fake
# classifier exercise stage 2 of the emergency guard in tests and in the CI eval.
_EMERGENCY_HINTS: tuple[str, ...] = (
    "ambulance",
    "ghabrahat",
    "ukhad",
    "pasina pasina",
    "jaan ko khatra",
    "urgent help",
    "bachao",
)


_QUERY_FILLER = frozenset(
    {
        "ka", "ki", "ke", "ko", "का", "की", "के", "को", "generic", "generics", "batao", "bataiye", "bataye", "btao", "alternative",
        "sasta", "saste", "cheaper", "cheap", "of", "for", "tell", "me", "about", "what", "is", "the", "a",
        "an", "medicine", "dawai", "dawa", "tablet", "tab", "please", "pls", "hai", "kya", "koi", "option",
        "vikalp", "to", "any", "version",
    }
)  # fmt: skip


def _fake_generic_extract(messages: Sequence[Message]) -> dict[str, Any]:
    """Offline stand-in for `generic_query_extract_v1`: copies the words that are not filler."""
    last = next((m.content for m in reversed(messages) if m.role == "user"), "")
    text = last.replace("<message>", " ").replace("</message>", " ")
    words = [
        w
        for w in text.replace("?", " ").replace(",", " ").split()
        if w.lower() not in _QUERY_FILLER
    ]
    strength = None
    for index, word in enumerate(words):
        if (
            word.lower() in {"mg", "mcg", "ml", "g"}
            and index > 0
            and words[index - 1].replace(".", "").isdigit()
        ):
            strength = f"{words[index - 1]} {word}"
    kept = [w for w in words if w.lower() not in {"mg", "mcg", "ml", "g"}]
    if strength:
        kept = [w for w in kept if w != strength.split()[0]]
    name = " ".join(kept) or None
    return {"medicine_name": name, "strength": strength, "confidence": 0.9 if name else 0.2}


_INTERACTION_SPLIT = re.compile(
    r"\s*(?:,|\+|&|\baur\b|\band\b|\bke saath\b|\bke sath\b|\bsaath\b|\bwith\b|\bya\b|\bor\b)\s*",
    re.IGNORECASE,
)
_INTERACTION_FILLER = frozenset(
    {
        "le",
        "sakte",
        "sakta",
        "sakti",
        "hain",
        "hai",
        "kya",
        "ek",
        "tablet",
        "tab",
        "ko",
        "me",
        "main",
        "lena",
        "lene",
        "safe",
        "together",
        "can",
        "i",
        "take",
        "is",
        "it",
        "ka",
        "ki",
        "ke",
        "ok",
        "to",
        "okay",
    }
)


def _fake_interaction_extract(messages: Sequence[Message]) -> dict[str, Any]:
    """Offline stand-in for `interaction_query_extract_v1`: splits on 'aur', 'and', commas ... and
    drops filler words. It copies words from the message and nothing else."""
    last = next((m.content for m in reversed(messages) if m.role == "user"), "")
    text = last.replace("<message>", " ").replace("</message>", " ").replace("?", " ")
    names: list[str] = []
    for part in _INTERACTION_SPLIT.split(text):
        words = [w for w in part.split() if w.lower() not in _INTERACTION_FILLER]
        if words:
            names.append(" ".join(words))
    return {"medicine_names": names[:4], "confidence": 0.9 if names else 0.2}


_LAB_FILLER = frozenset(
    {
        "matlab", "kya", "hai", "hota", "hoti", "what", "is", "mean", "means", "meaning", "ka", "ki",
        "ke", "ko", "mera", "meri", "my", "level", "value", "result", "report", "me", "mein", "aaya",
        "aya", "came", "test", "batao", "samjhao", "explain", "tell", "about", "for", "the", "a", "an",
        "ye", "yeh", "to", "of", "normal", "high", "low", "kitna", "kitni", "chahiye", "should",
        "be", "does", "do", "se", "hain",
    }
)  # fmt: skip


def _fake_lab_question_extract(messages: Sequence[Message]) -> dict[str, Any]:
    """Offline stand-in for `lab_question_extract_v1`: the first non-filler word is the test, the first
    number is its value. It copies words from the message and nothing else."""
    last = next((m.content for m in reversed(messages) if m.role == "user"), "")
    words = last.replace("<message>", " ").replace("</message>", " ").replace("?", " ").split()
    name = next(
        (w for w in words if w.lower() not in _LAB_FILLER and not w.replace(".", "").isdigit()),
        None,
    )
    value = next((w for w in words if w.replace(".", "", 1).isdigit()), None)
    return {"test_name": name, "value": value, "unit": None, "confidence": 0.9 if name else 0.2}


@dataclass(frozen=True, slots=True)
class FakeRule:
    """If `match` (case-insensitive) occurs in the last user message, answer with `response`."""

    match: str
    response: dict[str, Any] | str


FakeStep = str | dict[str, Any] | LLMError


def default_fake_response(
    messages: Sequence[Message], response_model: type[BaseModel] | None
) -> str:
    """The answer given when no script step or fixture rule applies."""
    if response_model is None:
        return "This is a fake LLM response."
    last_user = next((m.content for m in reversed(messages) if m.role == "user"), "").lower()
    fields = response_model.model_fields
    # M7: the prescription flow (classify -> extract -> compose). The fake never looks at pixels.
    if "kind" in fields and "quality" in fields and "confidence" in fields:
        return json.dumps(SAMPLE_CLASSIFICATION)
    if "is_lab_report" in fields:
        return json.dumps(SAMPLE_LAB_EXTRACTION)
    if "test_name" in fields:
        return json.dumps(_fake_lab_question_extract(messages))
    if "is_prescription" in fields:
        return json.dumps(SAMPLE_EXTRACTION)
    if "items" in fields:
        raw_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
        return fake_compose([m.content for m in messages], raw_user)
    if "medicine_names" in fields:
        return json.dumps(_fake_interaction_extract(messages))
    if "medicine_name" in fields:
        return json.dumps(_fake_generic_extract(messages))
    if "is_emergency" in response_model.model_fields:
        hit = any(hint in last_user for hint in _EMERGENCY_HINTS)
        return json.dumps(
            {
                "is_emergency": hit,
                "category": "cardiac" if hit else None,
                "confidence": 0.8 if hit else 0.9,
            }
        )
    if "intent" in response_model.model_fields:
        for intent, keywords in _INTENT_KEYWORDS:
            if any(keyword in last_user for keyword in keywords):
                return json.dumps({"intent": intent, "confidence": 0.9})
        words = set(last_user.replace("<message>", " ").replace("</message>", " ").split())
        if words and words <= _GREETING_WORDS:
            return json.dumps({"intent": "greeting", "confidence": 0.9})
        return json.dumps({"intent": "out_of_scope", "confidence": 0.9})
    raise NotImplementedError(f"no fake answer for {response_model.__name__}")


class FakeProvider:
    name = "fake"

    def __init__(
        self,
        script: Sequence[FakeStep] | None = None,
        rules: Sequence[FakeRule] | None = None,
    ) -> None:
        self._script = list(script or [])
        self._rules = list(rules or [])
        # Every call is recorded so tests can assert what the app asked the model.
        self.calls: list[dict[str, Any]] = []

    @classmethod
    def from_fixture(cls, path: Path) -> "FakeProvider":
        """`[{"match": "text to look for", "response": {...}}, ...]`"""
        raw = json.loads(path.read_text(encoding="utf-8"))
        return cls(rules=[FakeRule(match=item["match"], response=item["response"]) for item in raw])

    async def generate(
        self,
        messages: list[Message],
        *,
        model: str,
        temperature: float,
        max_tokens: int,
        response_model: type[BaseModel] | None = None,
        images: list[ImageInput] | None = None,
        timeout_s: float,
    ) -> RawResult:
        self.calls.append(
            {
                "model": model,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "response_model": response_model,
                "images": len(images or []),
                "messages": list(messages),
                "timeout_s": timeout_s,
            }
        )

        if self._script:
            step = self._script.pop(0)
            if isinstance(step, LLMError):
                raise step
            text = step if isinstance(step, str) else json.dumps(step)
        else:
            text = self._answer_from_rules(messages) or default_fake_response(
                messages, response_model
            )

        return RawResult(
            text=text,
            model=model,
            provider=self.name,
            input_tokens=sum(len(m.content.split()) for m in messages),
            output_tokens=len(text.split()),
            latency_ms=1,
        )

    def _answer_from_rules(self, messages: Sequence[Message]) -> str | None:
        last_user = next((m.content for m in reversed(messages) if m.role == "user"), "").lower()
        for rule in self._rules:
            if rule.match.lower() in last_user:
                return (
                    rule.response if isinstance(rule.response, str) else json.dumps(rule.response)
                )
        return None
