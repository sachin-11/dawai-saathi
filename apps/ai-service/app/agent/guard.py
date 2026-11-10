"""Checks around the agent's free text. The agent may add ONE short lead-in sentence; it may not carry a fact.

A lead-in is dropped (the tool texts are still shown) when it is long, contains a number that no tool
result contains, tells the user to stop / skip / avoid a medicine, or uses a Latin word that is neither an
ordinary connecting word nor present in a tool text. The strict word check is on purpose: a false positive
costs one missing lead-in line, a false negative would let the model name a medicine.
"""

import re
from collections.abc import Sequence
from typing import Final

from app.agent.tools import ToolResult
from app.interactions.verify import advice_to_stop

MAX_LEAD_CHARS: Final = 240
_WORD = re.compile(r"[A-Za-z][A-Za-z\-]{2,}")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
_ALLOWED_WORDS: Final = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "ask",
        "at",
        "be",
        "below",
        "above",
        "can",
        "check",
        "checked",
        "checking",
        "could",
        "did",
        "do",
        "does",
        "doctor",
        "for",
        "from",
        "give",
        "got",
        "has",
        "have",
        "here",
        "how",
        "if",
        "in",
        "information",
        "is",
        "it",
        "its",
        "let",
        "looked",
        "looking",
        "me",
        "medicine",
        "medicines",
        "my",
        "name",
        "names",
        "not",
        "of",
        "on",
        "one",
        "or",
        "please",
        "pharmacist",
        "pharmacists",
        "question",
        "results",
        "result",
        "see",
        "seen",
        "show",
        "shown",
        "shows",
        "so",
        "some",
        "that",
        "the",
        "their",
        "them",
        "these",
        "this",
        "those",
        "to",
        "up",
        "use",
        "used",
        "was",
        "what",
        "when",
        "which",
        "with",
        "would",
        "you",
        "your",
        "answer",
        "answers",
        "following",
        "found",
        "test",
        "tests",
        "lab",
        "interaction",
        "interactions",
        "details",
        "detail",
        "same",
    ]
)


def _tool_blob(results: Sequence[ToolResult]) -> str:
    return " ".join(r.text for r in results).lower()


def lead_in_is_safe(lead: str, results: Sequence[ToolResult]) -> bool:
    lead = lead.strip()
    if not lead or len(lead) > MAX_LEAD_CHARS:
        return False
    if advice_to_stop(lead):
        return False
    blob = _tool_blob(results)
    for number in _NUMBER.findall(lead):
        if number.lower() not in blob:
            return False
    for word in _WORD.findall(lead):
        w = word.lower()
        if w not in _ALLOWED_WORDS and w not in blob:
            return False
    return True
