"""The interaction nodes (M11, CLAUDE.md §8.2, §1 F6):

    prescription:  ... generic_finder -> interaction_check -> confidence_gate -> composer ...
    question:      classify -> extract_interaction_query -> match_query_medicines
                   -> interaction_check -> composer -> verifier

Every node is a thin wrapper around deterministic code: the only model call is `CHEAP_MODEL` copying
the medicine NAMES out of a question. No model ever states an interaction (CLAUDE.md §2.5).
"""

import asyncio
from typing import Any

from app.graph.nodes._util import static_reply
from app.graph.state import GraphState
from app.graph.traced import STATUS_KEY, traced_node
from app.interactions.service import (
    prescription_medications,
    stored_medications,
    typed_medications,
)
from app.pipeline.base import PipelineContext
from app.schemas.catalog import MatchMethod
from app.schemas.interactions import InteractionFinding, InteractionReport
from app.schemas.process import InputType, Intent, Warning, WarningType
from app.tools.intent import extract_interaction_names

ASK_NAMES_TEMPLATE = "interaction.ask_names"
UNAVAILABLE_TEMPLATE = "interaction.unavailable"


def warning_for(finding: InteractionFinding) -> Warning:
    """A warning is a CODE: type, salts and severity. Never a sentence (the contract says so)."""
    kind = (
        WarningType.duplicate_ingredient
        if finding.type == "duplicate_ingredient"
        else WarningType.interaction
    )
    severity = finding.severity or "duplicate"
    return Warning(type=kind, detail=f"{finding.salt_a}+{finding.salt_b}:{severity}")


# ---------------------------------------------------------------------------- extract question


def _extract_timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    return static_reply(ASK_NAMES_TEMPLATE, Intent.interaction_query)


@traced_node("extract_interaction_query", timeout="cheap", on_timeout=_extract_timed_out)
async def extract_interaction_query(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """The model only COPIES the medicine names out of the redacted message."""
    names = await extract_interaction_names(
        state.redacted_text or "",
        router=ctx.router,
        prompts=ctx.prompts,
        usage=ctx.usage,
        deadline=ctx.deadline,
    )
    has_stored = bool(state.request.context.active_medications)
    # Two names to compare, or one name to compare with what the user already takes.
    if not names or (len(names) < 2 and not has_stored):
        return static_reply(ASK_NAMES_TEMPLATE, Intent.interaction_query)
    return {"interaction_names": names}


# ---------------------------------------------------------------------------- match question


def _match_timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    return static_reply(UNAVAILABLE_TEMPLATE, Intent.interaction_query)


@traced_node("match_query_medicines", timeout="io", on_timeout=_match_timed_out)
async def match_query_medicines(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Catalog match for each typed name (deterministic). A catalog outage is said out loud."""
    assert ctx.catalog is not None  # noqa: S101 - classify only routes here with a catalog
    matches = await asyncio.gather(
        *(ctx.catalog.match(name, None, None) for name in state.interaction_names)
    )
    if any(m.note == "catalog_unavailable" for m in matches):
        return static_reply(UNAVAILABLE_TEMPLATE, Intent.interaction_query)
    if state.request.input.type is InputType.audio:
        # A name heard through speech-to-text that matches NOTHING (not a product, not a known
        # ingredient): it may be misheard, so ask for it in writing instead of "could not check".
        known = (
            await ctx.interactions.known_salts() if ctx.interactions is not None else frozenset()
        )
        if any(
            m.method is MatchMethod.none and " ".join(name.lower().split()) not in known
            for name, m in zip(state.interaction_names, matches, strict=True)
        ):
            return static_reply("voice.drug_unclear", Intent.interaction_query)
    return {"drug_matches": list(matches)}


# ---------------------------------------------------------------------------- interaction_check


def _check_timed_out(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """A slow database is "could not check", never "nothing found"."""
    return {
        "interaction_report": InteractionReport(database_ok=False),
        STATUS_KEY: "fallback",
    }


@traced_node("interaction_check", timeout="io", on_timeout=_check_timed_out)
async def interaction_check(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    """Duplicate ingredients and known interactions among the new and the stored medicines."""
    service = ctx.interactions
    if service is None:
        return {}  # not configured: say nothing rather than claim anything
    known = await service.known_salts()
    if state.intent is Intent.interaction_query:
        new = typed_medications(
            state.interaction_names,
            state.drug_matches,
            match_min=service.match_min,
            known_salts=known,
        )
    else:
        assert state.rx_extraction is not None  # noqa: S101 - routing guarantees it
        new = prescription_medications(
            state.rx_extraction,
            state.drug_matches,
            min_confidence=ctx.settings.extraction_min_confidence,
            match_min=service.match_min,
            known_salts=known,
        )
    stored = stored_medications(state.request.context.active_medications)
    report = await service.check([*new, *stored], only_new=True)
    update: dict[str, Any] = {
        "interaction_report": report,
        "warnings": [warning_for(f) for f in report.findings],
    }
    if not report.database_ok:
        update[STATUS_KEY] = "fallback"
    return update


__all__ = [
    "ASK_NAMES_TEMPLATE",
    "UNAVAILABLE_TEMPLATE",
    "extract_interaction_query",
    "interaction_check",
    "match_query_medicines",
    "warning_for",
]
