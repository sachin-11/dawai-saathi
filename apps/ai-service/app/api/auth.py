"""Service-to-service authentication: `X-Service-Token` == SERVICE_TOKEN (constant-time compare)."""

import hmac
from typing import Annotated

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
