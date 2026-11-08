"""verifier: the deterministic safety net before a reply leaves the service (CLAUDE.md §2.3-§2.5).

Consolidates every check from M7/M8 in one node. It never changes the reply: it returns a
`VerificationResult` (codes only, no text) and routing sends a failure to the template renderer.

  prescription  the LLM's lines (names, numbers, words) come from the data; every readable medicine's
                name is in the reply; a low-confidence medicine is flagged as unreadable; no rupee
                amount appears; the body leaves room for the disclaimer
  generics      DEFENCE IN DEPTH: every suggestion is re-checked here against the matched product: all
                four keys equal, a confident verified match, not in the no-substitute list
  typed query   every rupee amount and listed brand exists in the data
  always        text <= 4096, <= 3 buttons, titles <= 20, the disclaimer is present
"""

import re
from typing import Any

from app.graph.nodes._util import language_of
from app.graph.state import GraphState, VerificationResult
from app.graph.traced import traced_node
from app.pipeline.base import PipelineContext
from app.safety.disclaimers import DISCLAIMERS
from app.schemas.catalog import DrugMatch, GenericSuggestion, MatchMethod
from app.schemas.process import (
    MAX_BUTTON_TITLE_CHARS,
    MAX_BUTTONS,
    MAX_REPLY_CHARS,
    Intent,
)
from app.tools.generic_render import verify_generic_text
from app.tools.rx_compose import (
    LOW_CONFIDENCE_MARKERS,
    build_views,
    compose_payload,
    max_body_chars,
    render_reply_text,
)
from app.tools.rx_grounding import verify_items


def _squash(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", text.casefold())


async def generic_failures(
    match: DrugMatch | None,
    suggestion: GenericSuggestion | None,
    *,
    low_confidence: bool,
    ctx: PipelineContext,
) -> list[str]:
    """Why a suggestion must NOT be shown (empty list = it may be)."""
    if suggestion is None or not suggestion.alternatives:
        return []
    catalog = ctx.catalog
    if catalog is None:
        return ["generic_without_catalog"]
    if match is None or low_confidence:
        return ["generic_without_safe_match"]
    keys = (match.salt_key, match.strength_key, match.form_key, match.release_type)
    if (
        match.method is MatchMethod.none
        or match.score < catalog.finder.match_min
        or match.strength_conflict
        or match.form_conflict
        or match.ambiguous
        or match.strength_basis == "none"
        or None in keys
    ):
        return ["generic_unsafe_match"]
    assert match.salt_key and match.form_key and match.release_type  # noqa: S101 - checked via `keys`
    failures: list[str] = []
    if catalog.policy.reason(
        salt_key=match.salt_key, form_key=match.form_key, release_type=match.release_type
    ):
        failures.append("generic_not_substitutable")
    rows = {
        r.id: r for r in await catalog.repo.by_ids([a.drug_id for a in suggestion.alternatives])
    }
    for alternative in suggestion.alternatives:
        row = rows.get(alternative.drug_id)
        if row is None:
            failures.append("generic_unknown_drug")
        elif (row.salt_key, row.strength_key, row.form_key, row.release_type) != keys:
            failures.append("generic_four_key")
    return failures


async def collect_failures(state: GraphState, ctx: PipelineContext) -> list[str]:
    reply = state.reply
    if reply is None:
        return ["no_reply"]
    language = language_of(state)
    failures: list[str] = []

    # ---- always
    if len(reply.text) > MAX_REPLY_CHARS:
        failures.append("reply_too_long")
    if len(reply.buttons) > MAX_BUTTONS:
        failures.append("too_many_buttons")
    if any(len(button.title) > MAX_BUTTON_TITLE_CHARS for button in reply.buttons):
        failures.append("button_title_too_long")
    if DISCLAIMERS[language] not in reply.text:
        failures.append("disclaimer_missing")

    if state.intent is Intent.generic_query:
        failures += [
            f"query_{code}" for code in verify_generic_text(reply.text, state.generic_items)
        ]
        match = state.drug_matches[0] if state.drug_matches else None
        suggestion = state.generic_items[0].generic if state.generic_items else None
        failures += await generic_failures(match, suggestion, low_confidence=False, ctx=ctx)
        return list(dict.fromkeys(failures))

    extraction = state.rx_extraction
    if extraction is None:
        return [*failures, "no_extraction"]
    views = build_views(extraction, ctx.settings.extraction_min_confidence)

    if "₹" in reply.text:  # prices belong to the details message, never to the main reply
        failures.append("unexpected_amount")
    if state.reply_source == "llm":
        payload = compose_payload(views)
        lines = state.llm_lines or {}
        failures += verify_items(sorted(lines.items()), payload, language)
        if len(render_reply_text(views, extraction, language, lines)) > max_body_chars():
            failures.append("reply_too_long")
    squashed = _squash(reply.text)
    if any(v.name and not v.low and _squash(v.name) not in squashed for v in views):
        failures.append("name_missing")
    if any(v.low for v in views) and LOW_CONFIDENCE_MARKERS[language] not in reply.text:
        failures.append("low_confidence_not_flagged")
    for medicine, view in zip(extraction.medicines, views, strict=True):
        failures += await generic_failures(
            medicine.match, medicine.generic, low_confidence=view.low, ctx=ctx
        )
    return list(dict.fromkeys(failures))


@traced_node("verifier", timeout="io")
async def verifier(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    failures = await collect_failures(state, ctx)
    return {"verification": VerificationResult(ok=not failures, failures=failures)}
