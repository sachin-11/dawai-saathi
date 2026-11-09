from typing import Literal

import structlog
from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel

from app.config import Settings, llm_config_problems
from app.db.session import Database, check_database

router = APIRouter(prefix="/health", tags=["health"])
log = structlog.get_logger("health")

CheckStatus = Literal["ok", "fail"]


class LivenessResponse(BaseModel):
    status: Literal["ok"]


class ReadinessChecks(BaseModel):
    db: CheckStatus
    llm_config: CheckStatus
    # M15: informational. An open circuit makes the service "degraded" for the operator but it stays
    # ready: templates, the emergency rules and the catalog still work without any LLM.
    llm_circuits: Literal["closed", "partial", "open"] = "closed"


class ReadinessResponse(BaseModel):
    status: Literal["ok", "degraded"]
    checks: ReadinessChecks


@router.get("/live")
async def live() -> LivenessResponse:
    """Liveness: process is up. No dependency checks (that is /health/ready)."""
    return LivenessResponse(status="ok")


@router.get("/startup", responses={503: {"model": LivenessResponse}})
async def startup(request: Request, response: Response) -> dict[str, str]:
    """Startup probe (M15): 503 until the spaCy / Presidio models are loaded, so an orchestrator does
    not kill a container that is still warming up."""
    if not getattr(request.app.state, "started", False):
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "starting"}
    return {"status": "ok"}


@router.get("/ready", responses={503: {"model": ReadinessResponse}})
async def ready(request: Request, response: Response) -> ReadinessResponse:
    """Readiness: Postgres answers within 2 s and the LLM configuration is valid. 503 otherwise."""
    database: Database = request.app.state.db
    settings: Settings = request.app.state.settings
    db_ok = await check_database(database)
    problems = llm_config_problems(settings)
    if problems:
        # Variable names only (never values): safe to log, and tells the operator what to fix.
        log.warning("llm_config_invalid", problems=problems)
    llm_ok = not problems
    healthy = db_ok and llm_ok
    circuits = getattr(request.app.state.llm_router, "circuits", {})
    open_count = (
        sum(1 for is_open in circuits.values() if is_open) if isinstance(circuits, dict) else 0
    )
    circuit_state: Literal["closed", "partial", "open"] = (
        "closed" if open_count == 0 else ("open" if open_count == len(circuits) else "partial")
    )
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(
        status="ok" if healthy else "degraded",
        checks=ReadinessChecks(
            db="ok" if db_ok else "fail",
            llm_config="ok" if llm_ok else "fail",
            llm_circuits=circuit_state,
        ),
    )
