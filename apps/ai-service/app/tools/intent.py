"""Text intent classification and the typed-query name extraction (moved out of `pipeline/minimal.py`
in M9, unchanged in behaviour). Both calls use the CHEAP model on REDACTED text only.

The model's job is limited to picking one intent from a fixed list, or copying a medicine name out
of the message. None of its words ever reach the user (CLAUDE.md §2.5).
"""

import re
import unicodedata
from enum import StrEnum

from pydantic import BaseModel, Field

from app.llm.router import Deadline, LLMRouter
from app.llm.types import LLMResult, Message
from app.pipeline.base import RequestUsage
from app.prompts.registry import PromptRegistry
from app.schemas.process import Intent

INTENT_PROMPT_ID = "intent_text_v2"
GENERIC_EXTRACT_PROMPT_ID = "generic_query_extract_v1"
INTERACTION_EXTRACT_PROMPT_ID = "interaction_query_extract_v1"
LAB_QUESTION_PROMPT_ID = "lab_question_extract_v1"
MAX_QUERY_MEDICINES = 4
# Below this the classification is treated as "other": a guess must not trigger a specific answer.
MIN_INTENT_CONFIDENCE = 0.5


class ClassifiedIntent(StrEnum):
    """What the classifier may answer (prompt `intent_text_v2`). Mapped to the contract's `Intent`."""

    prescription_question = "prescription_question"
    lab_question = "lab_question"
    generic_query = "generic_query"
    interaction_query = "interaction_query"
    help = "help"
    greeting = "greeting"
    out_of_scope = "out_of_scope"


TO_CONTRACT_INTENT = {
    ClassifiedIntent.prescription_question: Intent.prescription,
    ClassifiedIntent.lab_question: Intent.lab_report,
    ClassifiedIntent.generic_query: Intent.generic_query,
    ClassifiedIntent.interaction_query: Intent.interaction_query,
    ClassifiedIntent.help: Intent.help,
    ClassifiedIntent.greeting: Intent.greeting,
    ClassifiedIntent.out_of_scope: Intent.out_of_scope,
}


# Static reply (a key of `templates/{hi,en}.yaml`) for the intents that need no further work.
TEMPLATE_FOR_INTENT = {
    Intent.help: "help",
    Intent.greeting: "greeting",
    Intent.out_of_scope: "out_of_scope",
    Intent.other: "help",  # unclear message: show what the assistant can do
}


class IntentResult(BaseModel):
    """Structured output of the intent classifier."""

    intent: ClassifiedIntent
    confidence: float = Field(ge=0.0, le=1.0)


class GenericQueryExtract(BaseModel):
    """Structured output of `generic_query_extract_v1`: words copied out of the message, nothing more."""

    medicine_name: str | None = Field(default=None, max_length=100)
    strength: str | None = Field(default=None, max_length=50)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


async def classify_intent(
    redacted_text: str,
    *,
    router: LLMRouter,
    prompts: PromptRegistry,
    usage: RequestUsage,
    deadline: Deadline,
) -> Intent:
    prompt = prompts.load(INTENT_PROMPT_ID)
    messages = [
        prompt.to_message(allowed_intents=", ".join(intent.value for intent in ClassifiedIntent)),
        # The user's text is DATA: passed as-is (never rendered as a template) and delimited.
        Message("user", f"<message>\n{redacted_text}\n</message>"),
    ]
    result = await router.generate(
        prompt.model_role,
        messages,
        name="classify_intent",
        temperature=prompt.temperature,
        max_tokens=100,
        response_model=IntentResult,
        prompt_version=prompt.version,
        deadline=deadline,
    )
    usage.add(result, prompt.version)

    parsed = result.parsed
    if not isinstance(parsed, IntentResult) or parsed.confidence < MIN_INTENT_CONFIDENCE:
        return Intent.other
    return TO_CONTRACT_INTENT[parsed.intent]


async def extract_generic_query(
    redacted_text: str,
    *,
    router: LLMRouter,
    prompts: PromptRegistry,
    usage: RequestUsage,
    deadline: Deadline,
) -> tuple[str, str | None] | None:
    """`(medicine name, written strength)` copied out of the message, or None when no name is clear."""
    prompt = prompts.load(GENERIC_EXTRACT_PROMPT_ID)
    result: LLMResult = await router.generate(
        prompt.model_role,
        [prompt.to_message(), Message("user", f"<message>\n{redacted_text}\n</message>")],
        name="generic_query_extract",
        temperature=prompt.temperature,
        max_tokens=100,
        response_model=GenericQueryExtract,
        prompt_version=prompt.version,
        deadline=deadline,
    )
    usage.add(result, prompt.version)
    parsed = result.parsed
    if not isinstance(parsed, GenericQueryExtract):
        return None
    name = clean_name(parsed.medicine_name)
    if not name or parsed.confidence < MIN_INTENT_CONFIDENCE:
        return None
    return name, parsed.strength


def clean_name(raw: str | None) -> str | None:
    """A printable one-line name of reasonable length, or None. Letters, combining marks (Devanagari
    vowel signs!), digits, spaces and a few separators survive; everything else becomes a space."""
    if not raw:
        return None
    kept = "".join(
        ch if unicodedata.category(ch)[0] in "LMN" or ch in " .-+/()" else " " for ch in raw
    )
    name = re.sub(r"\s+", " ", kept).strip()[:60]
    return name or None


class InteractionQueryExtract(BaseModel):
    """Structured output of `interaction_query_extract_v1`: names copied out of the message."""

    medicine_names: list[str] = Field(default_factory=list, max_length=10)
    confidence: float = Field(ge=0.0, le=1.0)


async def extract_interaction_names(
    redacted_text: str,
    *,
    router: LLMRouter,
    prompts: PromptRegistry,
    usage: RequestUsage,
    deadline: Deadline,
) -> list[str]:
    """The medicine names copied out of "Dolo aur Combiflam saath le sakte hain?" (deduplicated, at
    most `MAX_QUERY_MEDICINES`). Empty when the model is unsure: the caller then asks for the names."""
    prompt = prompts.load(INTERACTION_EXTRACT_PROMPT_ID)
    result: LLMResult = await router.generate(
        prompt.model_role,
        [prompt.to_message(), Message("user", f"<message>\n{redacted_text}\n</message>")],
        name="interaction_query_extract",
        temperature=prompt.temperature,
        max_tokens=150,
        response_model=InteractionQueryExtract,
        prompt_version=prompt.version,
        deadline=deadline,
    )
    usage.add(result, prompt.version)
    parsed = result.parsed
    if not isinstance(parsed, InteractionQueryExtract) or parsed.confidence < MIN_INTENT_CONFIDENCE:
        return []
    names: list[str] = []
    for raw in parsed.medicine_names:
        name = clean_name(raw)
        if name and name.casefold() not in {n.casefold() for n in names}:
            names.append(name)
    return names[:MAX_QUERY_MEDICINES]


class LabQuestionExtract(BaseModel):
    """Structured output of `lab_question_extract_v1`: the test (and number) copied out of the message."""

    test_name: str | None = Field(default=None, max_length=100)
    value: str | None = Field(default=None, max_length=30)
    unit: str | None = Field(default=None, max_length=30)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


async def extract_lab_question(
    redacted_text: str,
    *,
    router: LLMRouter,
    prompts: PromptRegistry,
    usage: RequestUsage,
    deadline: Deadline,
) -> LabQuestionExtract | None:
    """The test name (and the value, if typed) copied out of "TSH 6.2 matlab kya?". None when the
    model is unsure: the caller then asks which test is meant."""
    prompt = prompts.load(LAB_QUESTION_PROMPT_ID)
    result: LLMResult = await router.generate(
        prompt.model_role,
        [prompt.to_message(), Message("user", f"<message>\n{redacted_text}\n</message>")],
        name="lab_question_extract",
        temperature=prompt.temperature,
        max_tokens=100,
        response_model=LabQuestionExtract,
        prompt_version=prompt.version,
        deadline=deadline,
    )
    usage.add(result, prompt.version)
    parsed = result.parsed
    if not isinstance(parsed, LabQuestionExtract) or parsed.confidence < MIN_INTENT_CONFIDENCE:
        return None
    name = clean_name(parsed.test_name)
    value = clean_name(parsed.value)
    unit = clean_name(parsed.unit)
    if not name:
        return None
    return LabQuestionExtract(
        test_name=name, value=value[:20] if value else None, unit=unit, confidence=parsed.confidence
    )
