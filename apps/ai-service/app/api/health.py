from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/health", tags=["health"])


class LivenessResponse(BaseModel):
    status: Literal["ok"]


@router.get("/live")
async def live() -> LivenessResponse:
    """Liveness: process is up. Dependency checks belong to /health/ready (M1)."""
    return LivenessResponse(status="ok")
