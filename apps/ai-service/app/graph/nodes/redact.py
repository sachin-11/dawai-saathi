"""redact: only the redacted text may ever reach a model, a log or a trace (CLAUDE.md §2.6)."""

import asyncio
from typing import Any

from app.graph.state import GraphState
from app.graph.traced import traced_node
from app.pipeline.base import PipelineContext
from app.schemas.process import InputType


@traced_node("redact", timeout="io")
async def redact(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    if state.request.input.type is InputType.audio:
        return await _redact_transcript(state, ctx)
    result = await asyncio.to_thread(ctx.redactor.redact, state.raw_text or "")
    # The raw words are dropped here: nothing after this node can read them.
    return {"redacted_text": result.text, "raw_text": None}


_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")


async def _redact_transcript(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """A transcript is redacted in its own script (kept for the "you asked" line) and, when there is
    a Roman copy, that copy too: models read the Roman one. Devanagari digits become ASCII first so a
    spoken phone number is recognised in either script."""
    original = (state.raw_text or "").translate(_DEVANAGARI_DIGITS)
    redacted = await asyncio.to_thread(ctx.redactor.redact, original)
    text = redacted.text
    if state.roman_text:
        roman = await asyncio.to_thread(
            ctx.redactor.redact, state.roman_text.translate(_DEVANAGARI_DIGITS)
        )
        text = roman.text
    return {
        "redacted_text": text,
        "transcript_redacted": redacted.text,
        "raw_text": None,
        "roman_text": None,
    }
