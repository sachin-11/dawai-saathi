"""The lab report nodes (M12, CLAUDE.md §8.2, §1 F3, §7.3):

    image:  classify -> vision_extract_lab -> lab_normalize -> lab_compare -> lab_gate -> composer -> verifier
    text:   classify -> lab_question -> composer -> verifier        ("TSH 6.2 matlab kya?")

Everything after the vision call is deterministic. The only model calls are the VISION_MODEL reading the
pages and the CHEAP_MODEL copying a test name out of a typed question. No model ever interprets a value.
The emergency guard never sees text from a report (it is not user-typed text, CLAUDE.md §2.2).
"""

from typing import Any

from app.graph.nodes._util import static_reply, track
from app.graph.state import GraphState, NodeError
from app.graph.traced import STATUS_KEY, traced_node
from app.pipeline.base import PipelineContext
from app.schemas.lab_report import LabReportExtraction, SexField
from app.schemas.prescription import DateField, IntField
from app.schemas.process import Intent, Warning, WarningType
from app.tools.intent import LabQuestionExtract, extract_lab_question
from app.tools.lab_compare import compare_report
from app.tools.lab_normalize import normalize_report
from app.tools.lab_render import render_lab_question
from app.tools.vision_extract_lab import (
    LAB_EXTRACT_PROMPT_ID,
    LAB_EXTRACT_STRICT_PROMPT_ID,
    extract_lab_report,
)

EXTRACT_NODE = "vision_extract_lab"
UNAVAILABLE = "lab.unavailable"
UNREADABLE = "lab.unreadable"
NO_RESULTS = "lab.no_results"
ASK_TEST = "lab.question_none"
MIN_READABLE_RESULTS = 1


# ---------------------------------------------------------------------------- vision_extract_lab


def failed_extraction() -> LabReportExtraction:
    """Nothing usable was read: a PHI-free placeholder so the gateway can record a `failed` document."""
    return LabReportExtraction(
        is_lab_report=True,
        image_quality="unreadable",
        report_date=DateField(),
        patient_age=IntField(),
        patient_sex=SexField(),
        results=[],
        status="failed",
    )


@traced_node(EXTRACT_NODE, timeout="vision")
async def vision_extract_lab(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Read the report pages. A structure that stays invalid after the router's own repair is retried
    ONCE with the stricter prompt (the counter lives in the state, so there is no loop); after that:
    "I could not read this report, please do not rely on me" (CLAUDE.md §2.3)."""
    attempt = state.retries.get(EXTRACT_NODE, 0)
    prompt_id = LAB_EXTRACT_PROMPT_ID if attempt == 0 else LAB_EXTRACT_STRICT_PROMPT_ID
    extraction, result = await extract_lab_report(
        state.images,
        router=ctx.router,
        prompts=ctx.prompts,
        deadline=ctx.deadline,
        prompt_id=prompt_id,
    )
    track(ctx, result, prompt_id)
    update: dict[str, Any] = {"retries": {EXTRACT_NODE: attempt + 1}}
    if extraction is not None:
        return {**update, "lab_extraction": extraction}
    update["errors"] = [NodeError(node=EXTRACT_NODE, code="schema_invalid")]
    if attempt >= 1:  # no retry left: never guess
        return {
            **update,
            **static_reply(UNREADABLE, Intent.lab_report),
            "lab_extraction": failed_extraction(),
            STATUS_KEY: "fallback",
        }
    return update  # routing sends the request back to this node, once


# ---------------------------------------------------------------------------- lab_normalize


@traced_node("lab_normalize", timeout="io")
async def lab_normalize(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Names -> catalog tests, values -> numbers, units -> canonical. Fails CLOSED: with no lab
    catalog the critical-value check cannot run, so the reply says so instead of guessing."""
    assert state.lab_extraction is not None  # noqa: S101 - routing guarantees it
    index = await ctx.labs.index() if ctx.labs is not None else None
    if index is None:
        return static_reply(UNAVAILABLE, Intent.lab_report)
    return {"lab_extraction": normalize_report(state.lab_extraction, index)}


# ---------------------------------------------------------------------------- lab_compare


@traced_node("lab_compare", timeout="io")
async def lab_compare(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Status of every result (printed range > printed flag > fallback range), critical values, trends."""
    assert state.lab_extraction is not None and ctx.labs is not None  # noqa: S101
    index = await ctx.labs.index()
    if index is None:
        return static_reply(UNAVAILABLE, Intent.lab_report)
    user = state.request.user
    compared = compare_report(
        state.lab_extraction,
        index,
        minimum=ctx.settings.extraction_min_confidence,
        user_age=user.age,
        user_sex=user.sex,
        previous=state.request.context.previous_lab_results,
    )
    warnings = [
        Warning(type=WarningType.critical_value, detail=f"{r.test_code}:{r.status}")
        for r in compared.results
        if r.status in ("critical_high", "critical_low") and r.test_code
    ]
    return {"lab_extraction": compared, "warnings": warnings}


# ---------------------------------------------------------------------------- lab_gate


@traced_node("lab_gate", timeout="fast")
async def lab_gate(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Not a report / nothing readable -> a static reply; otherwise mark the document done or needs_review."""
    extraction = state.lab_extraction
    assert extraction is not None  # noqa: S101
    minimum = ctx.settings.extraction_min_confidence
    if not extraction.is_lab_report:
        return {
            **static_reply("rx.other", Intent.other),
            "lab_extraction": None,
        }
    if extraction.image_quality == "unreadable":
        return {
            **static_reply(UNREADABLE, Intent.lab_report),
            "lab_extraction": extraction.model_copy(update={"status": "failed", "results": []}),
        }
    if len(extraction.results) < MIN_READABLE_RESULTS:
        return {
            **static_reply(NO_RESULTS, Intent.lab_report),
            "lab_extraction": extraction.model_copy(update={"status": "failed"}),
        }
    weak = extraction.overall_confidence < minimum or extraction.unknown_count * 2 > len(
        extraction.results
    )
    # A critical value is never hidden behind "needs review": the reply is still sent.
    status = "needs_review" if weak else "done"
    return {
        "intent": Intent.lab_report,
        "lab_extraction": extraction.model_copy(update={"status": status}),
    }


# ---------------------------------------------------------------------------- lab_question


def _question_timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    return static_reply(ASK_TEST, Intent.lab_report)


@traced_node("lab_question", timeout="cheap", on_timeout=_question_timed_out)
async def lab_question(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """A typed question about one test: the model only COPIES the test name; the answer is the stored
    explanation plus the general range, rendered by a template (never an interpretation)."""
    question: LabQuestionExtract | None = await extract_lab_question(
        state.redacted_text or "",
        router=ctx.router,
        prompts=ctx.prompts,
        usage=ctx.usage,
        deadline=ctx.deadline,
    )
    if question is None or not question.test_name:
        return static_reply(ASK_TEST, Intent.lab_report)
    index = await ctx.labs.index() if ctx.labs is not None else None
    if index is None:
        return static_reply(UNAVAILABLE, Intent.lab_report)
    match = index.match(question.test_name, question.unit)
    answer = render_lab_question(
        match.test if match else None, question.value, state.request.user.language
    )
    return {
        "intent": Intent.lab_report,
        "lab_question_text": answer.text,
        "lab_question_code": answer.test_code,
        "lab_question_value": question.value,
    }


__all__ = [
    "lab_compare",
    "lab_gate",
    "lab_normalize",
    "lab_question",
    "vision_extract_lab",
]
