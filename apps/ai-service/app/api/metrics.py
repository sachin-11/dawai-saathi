"""GET /metrics: Prometheus exposition (M15). Never public: needs the METRICS_TOKEN bearer token.

Without a token it is open only outside production (local dev); production refuses to boot without
one (see Settings). The route is not part of the OpenAPI contract.
"""

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.config import Settings
from app.observability.metrics import METRICS, REGISTRY

router = APIRouter(include_in_schema=False)


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def require_metrics_token(
    settings: Annotated[Settings, Depends(_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    expected = settings.metrics_token
    if expected is None:
        return
    provided = (authorization or "").removeprefix("Bearer ").encode("utf-8")
    if not hmac.compare_digest(provided, expected.get_secret_value().encode("utf-8")):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing metrics token")


@router.get("/metrics", dependencies=[Depends(require_metrics_token)])
async def metrics(request: Request) -> Response:
    router_obj = request.app.state.llm_router
    circuits = getattr(router_obj, "circuits", None)
    if isinstance(circuits, dict):
        METRICS.circuit_states(circuits)
    return Response(generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)
