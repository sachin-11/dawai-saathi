"""The two emergency stages (CLAUDE.md §2.2). Both run on what the USER wrote, never on text read from
an image: routing sends images straight to `prepare_image` and never here (see `routing.route_input`).

  emergency_guard       stage 1: keyword rules on the RAW text, no model, answers at once on a match
  emergency_classifier  stage 2: CHEAP model on the REDACTED text; any failure keeps the rules' verdict
"""

from typing import Any

import structlog

from app.graph.nodes._util import emergency_update
from app.graph.state import GraphState
from app.graph.traced import traced_node
from app.pipeline.base import PipelineContext
from app.safety.emergency_guard import (
    EmergencyResult,
    transcript_user_texts,
    user_text_from_request,
)
from app.schemas.process import InputType

log = structlog.get_logger("emergency")


def _log_detected(result: EmergencyResult) -> None:
    # Category, source and a count: never the matched words.
    log.warning(
        "emergency_detected",
        category=result.category.value if result.category else None,
        source=result.source,
        matched_terms_count=result.matched_terms_count,
    )


@traced_node("emergency_guard", timeout="fast")
async def emergency_guard(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    if state.request.input.type is InputType.audio:
        # A voice note: the transcript, in both scripts, even when it is partial or low-confidence.
        for text in transcript_user_texts(state.raw_text, state.roman_text):
            result = ctx.guard.check_rules(text)
            if result.is_emergency:
                _log_detected(result)
                return emergency_update(result)
        return {"emergency": EmergencyResult(is_emergency=False)}
    user_text = user_text_from_request(state.request)
    if user_text is None:  # defensive: routing only sends user-written text here
        return {}
    result = ctx.guard.check_rules(user_text)
    if result.is_emergency:
        _log_detected(result)
        return {"raw_text": str(user_text), **emergency_update(result)}
    return {"raw_text": str(user_text), "emergency": result}


def _classifier_timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    return {}  # the rules' verdict stands: the classifier must never block a request


@traced_node("emergency_classifier", timeout="cheap", on_timeout=_classifier_timed_out)
async def emergency_classifier(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    result = await ctx.guard.classify(
        state.redacted_text or "",
        router=ctx.router,
        prompts=ctx.prompts,
        settings=ctx.settings,
        usage=ctx.usage,
    )
    if result.is_emergency:
        _log_detected(result)
        return emergency_update(result)
    return {"emergency": result}
