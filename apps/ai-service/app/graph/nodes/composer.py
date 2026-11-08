"""composer: turn the structured payload into the reply text (CLAUDE.md §2.5).

  prescription   the LLM phrases ONE line per readable medicine from the validated data (it never sees
                 the image or raw text); header, unreadable-medicine lines, warnings, disclaimer and
                 buttons are templates. The result is only a CANDIDATE: the `verifier` node checks it,
                 and a failed check ends in the deterministic renderer.
  generic_query  no LLM at all: `generic_details` / `generic_none` templates
A failing or slow model is a recoverable error: the template is used (status "fallback").
"""

from typing import Any

from app.graph.nodes._util import language_of, track
from app.graph.state import GraphState
from app.graph.traced import STATUS_KEY, traced_node
from app.llm.types import LLMResult
from app.pipeline.base import PipelineContext
from app.schemas.process import Intent, Reply
from app.tools.generic_render import render_generic_reply
from app.tools.rx_compose import (
    RX_COMPOSE_PROMPT_ID,
    RX_TEMPLATE_VERSION,
    build_reply,
    build_views,
    compose_payload,
    render_reply_text,
    request_llm_lines,
)


def template_reply(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """The reply rendered from the data alone (no model). Also what the fallback and the timeout use."""
    language = language_of(state)
    if state.intent is Intent.generic_query:
        text = render_generic_reply(state.generic_items, language)
        return {"reply": Reply(language=language, text=text), "reply_source": "template"}
    extraction = state.rx_extraction
    assert extraction is not None  # noqa: S101 - routing guarantees it
    views = build_views(extraction, ctx.settings.extraction_min_confidence)
    text = render_reply_text(views, extraction, language)
    return {"reply": build_reply(text, language, with_buttons=True), "reply_source": "template"}


def _timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    ctx.usage.add_prompt_version(RX_TEMPLATE_VERSION)
    return {**template_reply(state, ctx), "compose_problems": ["timeout"]}


@traced_node("composer", timeout="composer", on_timeout=_timed_out)
async def composer(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    if state.intent is Intent.generic_query:
        return template_reply(state, ctx)

    language = language_of(state)
    extraction = state.rx_extraction
    assert extraction is not None  # noqa: S101
    views = build_views(extraction, ctx.settings.extraction_min_confidence)
    payload = compose_payload(
        views
    )  # the READABLE medicines only: nothing else is phrased by the model

    lines: dict[int, str] | None = None
    result: LLMResult | None = None
    problems: list[str] = []
    if payload:  # when every medicine is unreadable there is nothing for the model to phrase
        lines, result, problems = await request_llm_lines(
            payload, language, router=ctx.router, prompts=ctx.prompts, deadline=ctx.deadline
        )
    track(ctx, result, RX_COMPOSE_PROMPT_ID)
    ctx.usage.add_prompt_version(RX_TEMPLATE_VERSION)

    if lines is None:
        update = template_reply(state, ctx)
        if problems:  # the model failed: a recovered error, not a clean run
            update.update({"compose_problems": problems, STATUS_KEY: "fallback"})
        return update

    text = render_reply_text(views, extraction, language, lines)
    return {
        "reply": build_reply(text, language, with_buttons=True),
        "reply_source": "llm",
        "llm_lines": lines,
    }
