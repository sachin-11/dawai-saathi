"""POST /v1/interaction-check and /v1/interaction-details (M11). Pure code: no model is called.

check    the CHECK command: all of the user's stored medicines against each other
details  the "Interaction details" button: the stored warnings re-read from the interaction rows, with
         the management line and the source of every row
"""

from typing import Any

import structlog
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from app.api.auth import require_service_token
from app.interactions.render import render_block, render_details
from app.interactions.service import InteractionService, stored_medications
from app.safety.disclaimers import add_disclaimer
from app.schemas.interaction_details import (
    InteractionDetailsRequest,
    InteractionDetailsResponse,
)
from app.schemas.interactions import InteractionFinding, InteractionReport
from app.schemas.process import ActiveMedication, Language, Reply, RequestId
from app.tools.interaction_check import duplicate_finding, finding_from_row, sort_findings

router = APIRouter(prefix="/v1", tags=["interactions"])
log = structlog.get_logger("interactions")

_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"description": "Missing or wrong X-Service-Token"},
    422: {"description": "Invalid request"},
}


class InteractionCheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: RequestId
    language: Language
    medications: list[ActiveMedication] = Field(default_factory=list, max_length=50)


class InteractionCheckResponse(BaseModel):
    request_id: RequestId
    interactions: InteractionReport
    reply: Reply


@router.post(
    "/interaction-check",
    response_model=InteractionCheckResponse,
    dependencies=[Depends(require_service_token)],
    responses=_RESPONSES,
)
async def interaction_check(
    body: InteractionCheckRequest, request: Request
) -> InteractionCheckResponse:
    """CHECK: every stored medicine against every other one (all findings, not only new ones)."""
    structlog.contextvars.bind_contextvars(request_id=body.request_id)
    service: InteractionService = request.app.state.interactions
    report = await service.check(stored_medications(body.medications), only_new=False)
    text = render_block(report, body.language)
    log.info(
        "interaction_check_done",
        medicines=len(body.medications),
        findings=len(report.findings),
        database_ok=report.database_ok,
    )  # counts only
    return InteractionCheckResponse(
        request_id=body.request_id,
        interactions=report,
        reply=Reply(language=body.language, text=add_disclaimer(text, body.language)),
    )


@router.post(
    "/interaction-details",
    response_model=InteractionDetailsResponse,
    dependencies=[Depends(require_service_token)],
    responses=_RESPONSES,
)
async def interaction_details(
    body: InteractionDetailsRequest, request: Request
) -> InteractionDetailsResponse:
    """The details message for stored warnings, rendered from the CURRENT interaction rows."""
    structlog.contextvars.bind_contextvars(request_id=body.request_id)
    service: InteractionService = request.app.state.interactions
    pairs = [(w.salt_a, w.salt_b) for w in body.warnings if w.type == "interaction"]
    database_ok = True
    rows = {}
    try:
        rows = {(r.salt_a, r.salt_b): r for r in await service.repo.pairs(pairs)}
    except Exception as error:  # DB down: say so instead of listing nothing
        database_ok = False
        log.warning("interaction_details_lookup_failed", error_type=type(error).__name__)

    findings: list[InteractionFinding] = []
    for warning in body.warnings:
        if warning.type == "duplicate_ingredient":
            findings.append(
                duplicate_finding(warning.salt_a, refs=[], labels=warning.labels, involves_new=True)
            )
        elif (row := rows.get((warning.salt_a, warning.salt_b))) is not None:
            findings.append(
                finding_from_row(row, refs=[], labels=warning.labels, involves_new=True)
            )
    report = InteractionReport(
        findings=sort_findings(findings),
        unchecked=body.unchecked,
        checked_count=body.checked_count,
        database_ok=database_ok,
    )
    text = render_details(report.findings, rows, report, body.language)
    log.info("interaction_details_done", findings=len(findings))  # counts only
    return InteractionDetailsResponse(
        request_id=body.request_id,
        reply=Reply(language=body.language, text=add_disclaimer(text, body.language)),
    )
