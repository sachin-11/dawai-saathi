"""The reply composer for prescriptions (M7, CLAUDE.md §2.5 grounding).

Layout of the reply (header, unreadable-item lines, warnings, disclaimer) and the button titles are
ours and deterministic. The LLM (`rx_compose_v1`, TEXT_MODEL, temperature 0) only phrases ONE LINE
per READABLE medicine, from the validated structured data and nothing else: it never sees the image
or raw OCR text. Its lines are then checked by `rx_grounding`; if any line is not grounded, or the
model fails, the same data is rendered by the template (`rx_reply.{hi,en}.j2`) without an LLM.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

import structlog
from jinja2 import StrictUndefined, TemplateError
from jinja2.sandbox import SandboxedEnvironment
from pydantic import BaseModel, ConfigDict, Field

from app.llm.router import Deadline, LLMRouter
from app.llm.types import LLMError, LLMResult, Message
from app.prompts.registry import TEMPLATE_DIR, PromptRegistry
from app.safety.disclaimers import add_disclaimer
from app.schemas.prescription import Medicine, PrescriptionExtraction
from app.schemas.process import MAX_REPLY_CHARS, Language, Reply, ReplyButton
from app.tools.rx_gate import unclear_fields
from app.tools.rx_grounding import MAX_ITEM_CHARS, verify_items

RX_COMPOSE_PROMPT_ID = "rx_compose_v1"
RX_TEMPLATE_VERSION = "rx_reply_v1"

log = structlog.get_logger("rx_compose")

_ENV = SandboxedEnvironment(
    loader=None,
    undefined=StrictUndefined,
    autoescape=False,
    trim_blocks=False,
    lstrip_blocks=False,
    keep_trailing_newline=False,
)

# ---------------------------------------------------------------- phrase tables


@dataclass(frozen=True, slots=True)
class _Phrases:
    forms: dict[str, str | None]
    timings: dict[str, str]
    timing_joiner: str
    food: dict[str, str]
    as_needed: str
    unclear: dict[str, str]
    unclear_joiner: str


_PHRASES: Final[dict[Language, _Phrases]] = {
    Language.en: _Phrases(
        forms={
            "tablet": "tablet",
            "capsule": "capsule",
            "syrup": "syrup",
            "injection": "injection",
            "drops": "drops",
            "cream": "cream",
            "inhaler": "inhaler",
            "powder": "powder",
            "other": None,
        },
        timings={
            "morning": "morning",
            "afternoon": "afternoon",
            "evening": "evening",
            "night": "night",
        },
        timing_joiner=" and ",
        food={"before": "before food", "after": "after food", "with": "with food"},
        as_needed="only when needed",
        unclear={"name": "name", "dose": "dose", "frequency": "timing"},
        unclear_joiner=", ",
    ),
    Language.hi: _Phrases(
        forms={
            "tablet": "गोली",
            "capsule": "कैप्सूल",
            "syrup": "सिरप",
            "injection": "इंजेक्शन",
            "drops": "ड्रॉप्स",
            "cream": "क्रीम",
            "inhaler": "इन्हेलर",
            "powder": "पाउडर",
            "other": None,
        },
        timings={"morning": "सुबह", "afternoon": "दोपहर", "evening": "शाम", "night": "रात"},
        timing_joiner=" और ",
        food={"before": "खाने से पहले", "after": "खाने के बाद", "with": "खाने के साथ"},
        as_needed="ज़रूरत पड़ने पर",
        unclear={"name": "नाम", "dose": "खुराक", "frequency": "समय"},
        unclear_joiner=", ",
    ),
}

_HI_DOSE_UNITS: Final = (
    (re.compile(r"\btablets?\b|\btabs?\b", re.IGNORECASE), "गोली"),
    (re.compile(r"\bcapsules?\b|\bcaps?\b", re.IGNORECASE), "कैप्सूल"),
    (re.compile(r"\bpuffs?\b", re.IGNORECASE), "पफ़"),
    (re.compile(r"\bdrops?\b", re.IGNORECASE), "बूँद"),
)


def _dose_text(dose: str | None, language: Language) -> str | None:
    if not dose:
        return None
    if language is Language.hi:
        for pattern, word in _HI_DOSE_UNITS:
            dose = pattern.sub(word, dose)
    return dose


# ---------------------------------------------------------------- views


@dataclass(slots=True)
class MedicineView:
    """One medicine as the composer and the template see it. Only extracted values, nothing more."""

    number: int  # 1-based, the number shown in the list
    low: bool
    name: str | None
    form: str | None
    strength: str | None
    dose: str | None
    frequency_code: str | None
    times_per_day: int | None
    timings: list[str]
    food: str | None
    duration_days: int | None
    as_needed: bool
    instructions: str | None
    unclear: list[str] = field(default_factory=list)


def build_views(extraction: PrescriptionExtraction, min_confidence: float) -> list[MedicineView]:
    views: list[MedicineView] = []
    for number, medicine in enumerate(extraction.medicines, start=1):
        unclear = unclear_fields(medicine, min_confidence)
        name_ok = "name" not in unclear and medicine.name.value is not None
        views.append(
            MedicineView(
                number=number,
                low=medicine.low_confidence or bool(unclear),
                # A name that could not be read is never shown, not even as a guess.
                name=medicine.name.value if name_ok else None,
                form=medicine.form.value,
                strength=medicine.strength.value,
                dose=medicine.dose.value,
                frequency_code=medicine.frequency_code.value,
                times_per_day=medicine.frequency_per_day.value,
                timings=list(medicine.timings.value or []),
                food=_food(medicine),
                duration_days=medicine.duration_days.value,
                as_needed=medicine.as_needed,
                instructions=medicine.instructions.value,
                unclear=unclear,
            )
        )
    return views


def _food(medicine: Medicine) -> str | None:
    value = medicine.relation_to_food.value
    return value if value in {"before", "after", "with"} else None


def compose_payload(views: list[MedicineView]) -> list[dict[str, Any]]:
    """What the composer LLM receives: the READABLE medicines only, as plain data."""
    return [
        {
            "index": v.number,
            "name": v.name,
            "form": v.form,
            "strength": v.strength,
            "dose": v.dose,
            "frequency_code": v.frequency_code,
            "times_per_day": v.times_per_day,
            "timings": v.timings,
            "food": v.food,
            "duration_days": v.duration_days,
            "as_needed": v.as_needed,
            "instructions": v.instructions,
        }
        for v in views
        if not v.low
    ]


# ---------------------------------------------------------------- rendering


def _template_rows(
    views: list[MedicineView], language: Language, llm_lines: dict[int, str] | None
) -> list[dict[str, Any]]:
    phrases = _PHRASES[language]
    rows: list[dict[str, Any]] = []
    for v in views:
        inside = [x for x in (phrases.forms.get(v.form or ""), v.strength) if x]
        head = None
        if v.name:
            head = f"{v.name} ({', '.join(inside)})" if inside else v.name
        parts: list[str] = []
        dose = _dose_text(v.dose, language)
        if dose:
            parts.append(dose)
        if v.as_needed:
            parts.append(phrases.as_needed)
        elif v.timings:
            parts.append(phrases.timing_joiner.join(phrases.timings[t] for t in v.timings))
        elif v.times_per_day:
            parts.append(_times_a_day(v.times_per_day, language))
        if v.food:
            parts.append(phrases.food[v.food])
        if v.duration_days:
            parts.append(_days(v.duration_days, language))
        if v.instructions:
            parts.append(v.instructions)
        rows.append(
            {
                "number": v.number,
                "low": v.low,
                "head": head,
                "parts": parts,
                "unclear_text": phrases.unclear_joiner.join(phrases.unclear[u] for u in v.unclear),
                "llm_line": (llm_lines or {}).get(v.number),
            }
        )
    return rows


def _times_a_day(count: int, language: Language) -> str:
    if language is Language.hi:
        return f"दिन में {count} बार"
    return f"{count} time a day" if count == 1 else f"{count} times a day"


def _days(count: int, language: Language) -> str:
    if language is Language.hi:
        return f"{count} दिन"
    return f"for {count} day" if count == 1 else f"for {count} days"


def _template(language: Language) -> Any:
    path = Path(TEMPLATE_DIR) / f"rx_reply.{language.value}.j2"
    return _ENV.from_string(path.read_text(encoding="utf-8"))


def render_reply_text(
    views: list[MedicineView],
    extraction: PrescriptionExtraction,
    language: Language,
    llm_lines: dict[int, str] | None = None,
) -> str:
    notes: list[str] = []
    if any("duplicate_name" in m.validation_notes for m in extraction.medicines):
        notes.append("duplicate")
    if extraction.image_quality == "poor":
        notes.append("poor_quality")
    try:
        body = _template(language).render(
            count=len(views),
            medicines=_template_rows(views, language, llm_lines),
            any_low=any(v.low for v in views),
            notes=notes,
        )
    except TemplateError:
        # A broken template is a bug in our code, never in the data; fail loudly.
        raise
    return re.sub(r"\n{3,}", "\n\n", body).strip()


# ---------------------------------------------------------------- the LLM step


class ComposedItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    text: str = Field(min_length=1, max_length=MAX_ITEM_CHARS * 2)


class ComposedItems(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ComposedItem] = Field(max_length=20)


@dataclass(frozen=True, slots=True)
class ComposeOutcome:
    text: str  # without the disclaimer
    used_llm: bool
    grounding_problems: list[str]
    llm_result: LLMResult | None = None


_LANGUAGE_NAMES: Final = {Language.hi: "Hindi", Language.en: "English"}


async def compose_text(
    extraction: PrescriptionExtraction,
    language: Language,
    *,
    min_confidence: float,
    router: LLMRouter,
    prompts: PromptRegistry,
    deadline: Deadline,
) -> ComposeOutcome:
    """The reply body: LLM lines when they pass the grounding check, the template otherwise."""
    views = build_views(extraction, min_confidence)
    payload = compose_payload(views)

    if not payload:  # every medicine is low confidence: nothing for the LLM to phrase
        return ComposeOutcome(render_reply_text(views, extraction, language), False, [])

    prompt = prompts.load(RX_COMPOSE_PROMPT_ID)
    messages = [
        prompt.to_message(language=language.value, language_name=_LANGUAGE_NAMES[language]),
        # Structured data only: no image, no raw OCR text (asserted in tests).
        Message("user", json.dumps({"medicines": payload}, ensure_ascii=False)),
    ]
    result: LLMResult | None = None
    problems: list[str] = []
    try:
        result = await router.generate(
            prompt.model_role,
            messages,
            name="compose_reply",
            temperature=prompt.temperature,
            max_tokens=1500,
            response_model=ComposedItems,
            prompt_version=prompt.version,
            deadline=deadline,
        )
    except LLMError as error:
        problems = [f"llm_{error.kind}"]

    if result is not None and isinstance(result.parsed, ComposedItems):
        items = [(item.index, item.text.strip()) for item in result.parsed.items]
        problems = verify_items(items, payload, language)
        if not problems:
            text = render_reply_text(views, extraction, language, dict(items))
            if len(text) <= MAX_REPLY_CHARS - 400:
                return ComposeOutcome(text, True, [], result)
            problems = ["reply_too_long"]

    # Fallback: same data, no LLM. Reason codes only: never the text.
    log.warning("composer_grounding_failed", reasons=problems)
    return ComposeOutcome(render_reply_text(views, extraction, language), False, problems, result)


# ---------------------------------------------------------------- buttons and final reply

_BUTTON_TITLES: Final[dict[Language, dict[str, str]]] = {
    Language.en: {
        "reminders": "Set reminders",
        "wrong": "Something is wrong",
        "generic": "Generic medicines",
    },
    Language.hi: {
        "reminders": "रिमाइंडर लगाएँ",
        "wrong": "कुछ गलत है",
        "generic": "जेनेरिक दवाई",
    },
}

DOCUMENT_ID_PLACEHOLDER = "{document_id}"


def rx_buttons(language: Language) -> list[ReplyButton]:
    """Ids carry the literal `{document_id}`: the gateway substitutes the real id once it has saved
    the document (the AI service never knows it). Titles are at most 20 characters."""
    titles = _BUTTON_TITLES[language]
    return [
        ReplyButton(id=f"rx:reminders:{DOCUMENT_ID_PLACEHOLDER}", title=titles["reminders"]),
        ReplyButton(id=f"rx:generic:{DOCUMENT_ID_PLACEHOLDER}", title=titles["generic"]),
        ReplyButton(id=f"rx:wrong:{DOCUMENT_ID_PLACEHOLDER}", title=titles["wrong"]),
    ]


def build_reply(text: str, language: Language, *, with_buttons: bool) -> Reply:
    return Reply(
        language=language,
        text=add_disclaimer(text, language),
        buttons=rx_buttons(language) if with_buttons else [],
    )
