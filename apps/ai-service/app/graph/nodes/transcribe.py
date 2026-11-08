"""transcribe: placeholder until voice notes arrive (M13). Then it sets `raw_text` and routing sends
the transcript through the emergency guard like typed text. Until then audio gets the static
"received" reply, exactly as before."""

from typing import Any

from app.graph.nodes._util import static_reply
from app.graph.state import GraphState
from app.graph.traced import traced_node
from app.pipeline.base import PipelineContext
from app.schemas.process import Intent


@traced_node("transcribe", timeout="fast")
async def transcribe(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    return static_reply("received_media", Intent.other)
