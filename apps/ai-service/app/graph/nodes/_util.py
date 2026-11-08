"""Small helpers shared by the nodes."""

from typing import Any

from app.graph.state import GraphState
from app.llm.types import LLMResult
from app.pipeline.base import PipelineContext
from app.safety.emergency_guard import EmergencyResult
from app.schemas.process import Intent, Language


def language_of(state: GraphState) -> Language:
    return state.request.user.language


def track(ctx: PipelineContext, result: LLMResult | None, prompt_version: str) -> None:
    """Add a call's cost to the request and ALWAYS record the prompt version used (also when the call
    failed: `documents.prompt_version` must say what was attempted)."""
    ctx.usage.add_prompt_version(prompt_version)
    if result is not None:
        ctx.usage.add(result, prompt_version)


def static_reply(key: str, intent: Intent) -> dict[str, Any]:
    """Update that ends the request with the static template `key` (see the `templates` node)."""
    return {"template_key": key, "intent": intent}


def emergency_update(result: EmergencyResult) -> dict[str, Any]:
    key = "emergency.self_harm" if result.kind == "self_harm" else "emergency.general"
    return {"emergency": result, "intent": Intent.emergency, "template_key": key}
