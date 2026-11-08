"""Static replies and the deterministic fallback renderer (CLAUDE.md §2.5).

templates           help, greeting, out_of_scope, coming_soon (lab M12, interactions M11, voice M13),
                    resend tips, needs_review, the emergency text ... all fixed texts from
                    `app/prompts/templates/*.yaml`; nothing a model wrote ever gets here
rx_fallback         when the verifier rejects a reply: the same data rendered by the j2 templates,
                    with any generic suggestion that failed its re-check removed
"""

from typing import Any

import structlog

from app.graph.nodes._util import language_of
from app.graph.nodes.composer import template_reply
from app.graph.state import GraphState, NodeError
from app.graph.traced import STATUS_KEY, traced_node
from app.observability.metrics import METRICS
from app.pipeline.base import PipelineContext
from app.schemas.catalog import GenericSuggestion
from app.schemas.process import Intent, Reply
from app.tools.generic_render import DetailItem

log = structlog.get_logger("verifier")

# Verifier codes that mean "a generic suggestion is not safe": the fallback drops every suggestion.
_GENERIC_PREFIX = "generic_"
_QUERY_GENERIC_FAILURES = frozenset({"generic_four_key", "generic_not_substitutable"})


@traced_node("templates", timeout="fast")
async def templates(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    language = language_of(state)
    key = state.template_key or "help"  # unreachable: routing only sends a state with a key here
    return {
        "reply": Reply(language=language, text=ctx.templates.get(language, key)),
        "reply_source": "template",
        "intent": state.intent or Intent.other,
    }


@traced_node("rx_fallback", timeout="fast")
async def rx_fallback_renderer(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    failures = state.verification.failures if state.verification else []
    METRICS.count_fallback("verifier_failed")
    log.warning("composer_grounding_failed", reasons=failures)  # codes only, never text
    drop_generics = any(code.startswith(_GENERIC_PREFIX) for code in failures)
    errors = [NodeError(node="verifier", code=failures[0] if failures else "failed")]

    if state.intent is Intent.generic_query:
        items = state.generic_items
        if drop_generics:  # say "could not suggest", never show what failed its re-check
            items = [
                DetailItem(
                    i.number, i.name, i.strength, GenericSuggestion(reason_if_none="no_match")
                )
                for i in items
            ]
        rendered = template_reply(state.model_copy(update={"generic_items": items}), ctx)
        return {**rendered, "generic_items": items, "errors": errors, STATUS_KEY: "fallback"}

    update: dict[str, Any] = {}
    working = state
    if drop_generics and state.rx_extraction is not None:
        medicines = [m.model_copy(update={"generic": None}) for m in state.rx_extraction.medicines]
        extraction = state.rx_extraction.model_copy(update={"medicines": medicines})
        update["rx_extraction"] = extraction
        working = state.model_copy(update={"rx_extraction": extraction})
    update.update(template_reply(working, ctx))
    return {**update, "errors": errors, STATUS_KEY: "fallback"}
