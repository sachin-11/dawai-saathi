from typing import Literal

from fastapi import APIRouter, Request, Response, status
from pydantic import BaseModel

from app.db.session import Database, check_database

router = APIRouter(prefix="/health", tags=["health"])

CheckStatus = Literal["ok", "fail"]


class LivenessResponse(BaseModel):
    status: Literal["ok"]


class ReadinessChecks(BaseModel):
    db: CheckStatus


class ReadinessResponse(BaseModel):
    status: Literal["ok", "degraded"]
    checks: ReadinessChecks


@router.get("/live")
async def live() -> LivenessResponse:
    """Liveness: process is up. No dependency checks (that is /health/ready)."""
    return LivenessResponse(status="ok")


@router.get("/ready", responses={503: {"model": ReadinessResponse}})
async def ready(request: Request, response: Response) -> ReadinessResponse:
    """Readiness: Postgres answers within 2 s. 503 (same body shape) otherwise."""
    database: Database = request.app.state.db
    db_ok = await check_database(database)
    if not db_ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(
        status="ok" if db_ok else "degraded",
        checks=ReadinessChecks(db="ok" if db_ok else "fail"),
    )
