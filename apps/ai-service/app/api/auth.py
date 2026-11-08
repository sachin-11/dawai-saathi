"""Service-to-service authentication: `X-Service-Token` == SERVICE_TOKEN (constant-time compare)."""

import hmac
from typing import Annotated, Literal

from fastapi import Depends, Header, HTTPException, Request, status

from app.config import Settings


def get_app_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def require_service_token(
    settings: Annotated[Settings, Depends(get_app_settings)],
    x_service_token: Annotated[str | None, Header()] = None,
) -> None:
    """401 unless the header matches. `compare_digest` takes the same time for every wrong guess."""
    expected = settings.service_token.encode("utf-8")
    provided = (x_service_token or "").encode("utf-8")
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing service token")


Caller = Literal["gateway", "demo"]


def identify_caller(
    settings: Annotated[Settings, Depends(get_app_settings)],
    x_service_token: Annotated[str | None, Header()] = None,
) -> Caller:
    """401 unless the header is the gateway's SERVICE_TOKEN or the demo's DEMO_SERVICE_TOKEN.

    Only `/v1/process` uses this: the demo token is accepted nowhere else, and only a "demo" caller can
    receive `debug_trace`. Both comparisons run (constant time), so a wrong guess costs the same.
    """
    provided = (x_service_token or "").encode("utf-8")
    is_gateway = hmac.compare_digest(provided, settings.service_token.encode("utf-8"))
    demo = settings.demo_service_token
    is_demo = demo is not None and hmac.compare_digest(
        provided, demo.get_secret_value().encode("utf-8")
    )
    if is_gateway:
        return "gateway"
    if is_demo:
        return "demo"
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing service token")
