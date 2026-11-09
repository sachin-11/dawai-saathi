"""The prescription nodes: vision_extract_rx -> validate_rx -> normalize_drugs -> generic_finder ->
confidence_gate, plus `extract_query` for the typed "Dolo 650 ka generic batao" branch.

Every node is a thin wrapper around a tool from M7/M8: the business logic did not move or change.
"""

import asyncio
from typing import Any

from app.graph.nodes._util import static_reply, track
from app.graph.state import GraphState, NodeError
from app.graph.traced import STATUS_KEY, traced_node
from app.pipeline.base import PipelineContext
from app.schemas.catalog import GenericSuggestion
from app.schemas.process import Intent
from app.tools.generic_finder import MedicineFacts
from app.tools.generic_render import DetailItem
from app.tools.intent import extract_generic_query
from app.tools.rx_enrich import (
    NEEDS_REVIEW_WARNING,
    attach_catalog,
    find_generics,
    match_medicines,
    needs_review_extraction,
    redact_free_text,
)
from app.tools.rx_gate import apply_gate
from app.tools.rx_validate import validate_extraction
from app.tools.vision_extract_rx import RX_EXTRACT_PROMPT_ID, extract_prescription

RX_EXTRACT_STRICT_PROMPT_ID = "rx_extract_strict_v1"
EXTRACT_NODE = "vision_extract_rx"
RX_MAX_PAGES = 3


def _is_query(state: GraphState) -> bool:
    return state.intent is Intent.generic_query


# ---------------------------------------------------------------------------- vision_extract_rx


@traced_node(EXTRACT_NODE, timeout="vision")
async def vision_extract_rx(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Read the prescription. A structure that stays invalid after the router's own repair is retried
    ONCE with the stricter prompt (the retry counter lives in the state, so there can be no loop);
    after that the reply is "I could not read this, please confirm with your pharmacist" (§2.3)."""
    attempt = state.retries.get(EXTRACT_NODE, 0)
    prompt_id = RX_EXTRACT_PROMPT_ID if attempt == 0 else RX_EXTRACT_STRICT_PROMPT_ID
    extraction, result = await extract_prescription(
        state.images[:RX_MAX_PAGES],  # a PDF may be rendered for a lab report (more pages)
        router=ctx.router,
        prompts=ctx.prompts,
        deadline=ctx.deadline,
        prompt_id=prompt_id,
    )
    track(ctx, result, prompt_id)
    update: dict[str, Any] = {"retries": {EXTRACT_NODE: attempt + 1}}
    if extraction is not None:
        return {**update, "rx_extraction": extraction}
    update["errors"] = [NodeError(node=EXTRACT_NODE, code="schema_invalid")]
    if attempt >= 1:  # no retry left: never guess
        return {
            **update,
            **static_reply("rx.needs_review", Intent.prescription),
            "rx_extraction": needs_review_extraction(),
            "warnings": [NEEDS_REVIEW_WARNING],
            STATUS_KEY: "fallback",
        }
    return update  # routing sends the request back to this node, once


# ---------------------------------------------------------------------------- validate_rx


@traced_node("validate_rx", timeout="io")
async def validate_rx(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Redact the few free-text fields, then the deterministic validators (written codes beat the model)."""
    assert state.rx_extraction is not None  # noqa: S101 - routing guarantees it
    extraction = await asyncio.to_thread(redact_free_text, state.rx_extraction, ctx.redactor)
    return {
        "rx_extraction": validate_extraction(extraction, ctx.settings.extraction_min_confidence)
    }


# ---------------------------------------------------------------------------- normalize_drugs


def _match_timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """A slow catalog: carry on without catalog data (the reply is the M7 reply)."""
    if _is_query(state):
        return static_reply("generic_query_unavailable", Intent.generic_query)
    count = len(state.rx_extraction.medicines) if state.rx_extraction else 0
    return {"drug_matches": [None] * count}


@traced_node("normalize_drugs", timeout="io", on_timeout=_match_timed_out)
async def normalize_drugs(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Match each medicine to the catalog (salt, strength, form, release). Deterministic: no LLM."""
    if _is_query(state):
        assert ctx.catalog is not None and state.query_name  # noqa: S101 - routing guarantees it
        match = await ctx.catalog.match(state.query_name, state.query_strength, None)
        if match.note == "catalog_unavailable":  # say so instead of "not in my list"
            return static_reply("generic_query_unavailable", Intent.generic_query)
        return {"drug_matches": [match]}
    assert state.rx_extraction is not None  # noqa: S101
    matches = await match_medicines(
        state.rx_extraction, ctx.catalog, ctx.settings.extraction_min_confidence
    )
    return {"drug_matches": matches}


# ---------------------------------------------------------------------------- generic_finder


def _finder_timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    if _is_query(state):
        return static_reply("generic_query_unavailable", Intent.generic_query)
    return _attach(state, [None] * len(state.drug_matches))


def _attach(state: GraphState, generics: list[GenericSuggestion | None]) -> dict[str, Any]:
    assert state.rx_extraction is not None  # noqa: S101
    return {
        "generics": generics,
        "rx_extraction": attach_catalog(state.rx_extraction, state.drug_matches, generics),
    }


@traced_node("generic_finder", timeout="io", on_timeout=_finder_timed_out)
async def generic_finder(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Cheaper alternatives with the SAME salt + strength + form + release type (CLAUDE.md §2.4)."""
    if _is_query(state):
        assert ctx.catalog is not None and state.query_name  # noqa: S101
        (match,) = state.drug_matches
        assert match is not None  # noqa: S101
        suggestion = await ctx.catalog.generic(match, MedicineFacts())
        shown = match.brand_name or state.query_name  # the catalog's spelling when it knows it
        item = DetailItem(1, shown, state.query_strength, suggestion)
        return {"generics": [suggestion], "generic_items": [item]}
    assert state.rx_extraction is not None  # noqa: S101
    generics = await find_generics(
        state.rx_extraction,
        state.drug_matches,
        ctx.catalog,
        ctx.settings.extraction_min_confidence,
    )
    return _attach(state, generics)


# ---------------------------------------------------------------------------- confidence_gate


@traced_node("confidence_gate", timeout="fast")
async def confidence_gate(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """A medicine whose name, dose or frequency is unclear is flagged, never guessed (CLAUDE.md §2.3)."""
    assert state.rx_extraction is not None  # noqa: S101
    gate = apply_gate(state.rx_extraction, ctx.settings.extraction_min_confidence)
    if gate.failure == "not_a_prescription":
        return {
            **static_reply("rx.other", Intent.other),
            "rx_extraction": None,
            "interaction_report": None,
            "gate_failure": gate.failure,
        }
    if gate.failure is not None:
        # Unreadable / nothing readable: keep the (PHI-free) extraction so the gateway records a failed
        # document, but show no medicine list and ask for a better photo.
        return {
            **static_reply("rx.unreadable", Intent.prescription),
            "rx_extraction": gate.extraction,
            "warnings": gate.warnings,
            "interaction_report": None,  # nothing readable: no interaction claim, no persisted warning
            "gate_failure": gate.failure,
        }
    return {
        "intent": Intent.prescription,
        "rx_extraction": gate.extraction,
        "warnings": gate.warnings,
    }


# ---------------------------------------------------------------------------- extract_query


def _query_timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    return static_reply("generic_query_ask_name", Intent.generic_query)


@traced_node("extract_query", timeout="cheap", on_timeout=_query_timed_out)
async def extract_query(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """The model only COPIES the medicine name (and a written strength) out of the redacted message."""
    query = await extract_generic_query(
        state.redacted_text or "",
        router=ctx.router,
        prompts=ctx.prompts,
        usage=ctx.usage,
        deadline=ctx.deadline,
    )
    if query is None:
        return static_reply("generic_query_ask_name", Intent.generic_query)
    name, strength = query
    return {"query_name": name, "query_strength": strength}


__all__ = [
    "RX_EXTRACT_STRICT_PROMPT_ID",
    "confidence_gate",
    "extract_query",
    "generic_finder",
    "normalize_drugs",
    "validate_rx",
    "vision_extract_rx",
]
