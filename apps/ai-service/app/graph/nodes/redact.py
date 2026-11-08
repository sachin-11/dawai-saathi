"""redact: only the redacted text may ever reach a model, a log or a trace (CLAUDE.md §2.6)."""

import asyncio
from typing import Any

from app.graph.state import GraphState
from app.graph.traced import traced_node
from app.pipeline.base import PipelineContext


@traced_node("redact", timeout="io")
async def redact(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    result = await asyncio.to_thread(ctx.redactor.redact, state.raw_text or "")
    # The raw words are dropped here: nothing after this node can read them.
    return {"redacted_text": result.text, "raw_text": None}
