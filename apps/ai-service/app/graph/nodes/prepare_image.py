"""prepare_image: fetch the file, render PDF pages, strip metadata, refuse a hopeless photo (M7)."""

from typing import Any

from app.graph.nodes._util import static_reply
from app.graph.state import GraphState
from app.graph.traced import traced_node
from app.pipeline.base import PipelineContext
from app.safety.budget import budget_state_of, busy_update
from app.schemas.process import Intent
from app.tools.image_input import load_images


@traced_node("prepare_image", timeout="io")
async def prepare_image(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    if budget_state_of(state) == "exhausted":  # M15: nothing is read; skip the download too
        return busy_update(state, "budget.busy", "image")
    loaded = await load_images(state.request, ctx.settings)
    if loaded.template_key is not None:
        return static_reply(loaded.template_key, Intent.other)
    return {"images": loaded.images}
