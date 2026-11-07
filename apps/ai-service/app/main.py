"""FastAPI application factory.

Run with: `uvicorn app.main:create_app --factory --port 8000`
(the factory keeps imports side-effect free, so tests can inject settings).
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import health
from app.api.v1 import router as v1_router
from app.config import Settings, get_settings
from app.observability.logging import configure_logging
from app.observability.request_id import RequestIdMiddleware, current_request_id
from app.schemas.errors import error_body


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    is_prod = settings.environment == "production"
    app = FastAPI(
        title="Dawai Saathi AI Service",
        version="0.0.0",
        docs_url=None if is_prod else "/docs",
        redoc_url=None,
        openapi_url=None if is_prod else "/openapi.json",
    )
    app.state.settings = settings

    app.add_middleware(RequestIdMiddleware)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)

    app.include_router(health.router)
    app.include_router(v1_router)
    return app


async def _http_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)  # noqa: S101 - narrowing for mypy
    body = error_body(exc.status_code, str(exc.detail), current_request_id())
    return JSONResponse(body.model_dump(exclude_none=True), status_code=exc.status_code)


async def _validation_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)  # noqa: S101 - narrowing for mypy
    # Only field locations + messages; never echo the input (may contain PHI).
    details = [
        f"{'.'.join(str(p) for p in err.get('loc', ()))}: {err.get('msg', 'invalid')}"
        for err in exc.errors()
    ]
    body = error_body(422, "Request validation failed", current_request_id(), details)
    return JSONResponse(body.model_dump(exclude_none=True), status_code=422)
