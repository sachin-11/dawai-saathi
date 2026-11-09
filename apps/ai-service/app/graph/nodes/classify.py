"""classify: what is this? Image -> prescription / lab report / strip / other (CHEAP vision model);
text -> an intent from a fixed list (CHEAP model, REDACTED text). The model only picks from a list:
none of its words reach the user, which is why an off-topic question can never be answered by it."""

from typing import Any

from app.graph.nodes._util import static_reply, track
from app.graph.state import GraphState
from app.graph.traced import traced_node
from app.pipeline.base import PipelineContext
from app.schemas.process import Intent
from app.tools.classify_image import IMAGE_CLASSIFY_PROMPT_ID, classify_image
from app.tools.intent import TEMPLATE_FOR_INTENT, classify_intent


def _timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """A slow cheap model: treat the input as unclear and show the help / ask for a clear photo."""
    if state.images:
        return static_reply("rx.other", Intent.other)
    return static_reply("help", Intent.other)


@traced_node("classify", timeout="cheap", on_timeout=_timed_out)
async def classify(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    if state.images:
        return await _classify_image(state, ctx)

    intent = await classify_intent(
        state.redacted_text or "",
        router=ctx.router,
        prompts=ctx.prompts,
        usage=ctx.usage,
        deadline=ctx.deadline,
    )
    if intent is Intent.generic_query and ctx.catalog is not None:
        return {"intent": intent}
    if intent is Intent.lab_report and ctx.labs is not None:
        return {"intent": intent}  # M12: "TSH 6.2 matlab kya?" -> lab_question
    if (
        intent is Intent.interaction_query
        and ctx.catalog is not None
        and ctx.interactions is not None
    ):
        return {"intent": intent}
    return static_reply(TEMPLATE_FOR_INTENT.get(intent, "coming_soon"), intent)


async def _classify_image(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    classification, result = await classify_image(
        state.images, router=ctx.router, prompts=ctx.prompts, deadline=ctx.deadline
    )
    track(ctx, result, IMAGE_CLASSIFY_PROMPT_ID)
    kind = classification.kind
    update: dict[str, Any] = {"image_kind": kind}
    if kind == "lab_report":
        if ctx.labs is None:  # no lab catalog wired (tests / a rollback): the old placeholder reply
            return {**update, **static_reply("rx.lab_report", Intent.lab_report)}
        if classification.quality == "unreadable":
            return {**update, **static_reply("lab.unreadable", Intent.lab_report)}
        return {**update, "intent": Intent.lab_report}
    if kind == "medicine_strip":
        return {**update, **static_reply("rx.medicine_strip", Intent.other)}
    if kind == "other":
        return {**update, **static_reply("rx.other", Intent.other)}
    if classification.quality == "unreadable":
        return {**update, **static_reply("rx.unreadable", Intent.other)}
    return {**update, "intent": Intent.prescription}
