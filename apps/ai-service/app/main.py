"""FastAPI application factory.

Run with: `uvicorn app.main:create_app --factory --port 8000`
(the factory keeps imports side-effect free, so tests can inject settings).
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import health
from app.api.errors import ApiError
from app.api.limits import BodySizeLimitMiddleware
from app.api.v1 import router as v1_router
from app.catalog.service import CatalogService
from app.config import Settings, get_settings
from app.db.session import Database
from app.llm.factory import build_llm_router
from app.llm.router import LLMRouter
from app.llm.types import LLMConfigError
from app.observability.logging import configure_logging
from app.observability.request_id import RequestIdMiddleware, current_request_id
from app.observability.tracing import Tracer, build_tracer, observe_llm_call
from app.pipeline.base import Pipeline
from app.pipeline.minimal import MinimalPipeline
from app.pipeline.rx import RxPipeline
from app.prompts.registry import PromptRegistry, TemplateStore
from app.safety.emergency_guard import EmergencyGuard
from app.safety.redaction import Redactor, configure_redactor
from app.schemas.errors import error_body


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Build Presidio + the spaCy model ONCE, before the first request. A missing model aborts boot.
    redactor: Redactor = app.state.redactor
    redactor.warm_up()
    yield
    # Graceful shutdown: send pending traces, close pooled DB connections.
    tracer: Tracer = app.state.tracer
    tracer.shutdown()
    await app.state.db.dispose()


def create_app(
    settings: Settings | None = None,
    *,
    llm_router: LLMRouter | None = None,
    tracer: Tracer | None = None,
    pipeline: Pipeline | None = None,
    catalog: CatalogService | None = None,
) -> FastAPI:
    """Build the app. The keyword arguments let tests inject fakes; production uses the defaults."""
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    is_prod = settings.environment == "production"
    app = FastAPI(
        title="Dawai Saathi AI Service",
        version="0.0.0",
        docs_url=None if is_prod else "/docs",
        redoc_url=None,
        openapi_url=None if is_prod else "/openapi.json",
        lifespan=_lifespan,
    )
    app.state.settings = settings
    app.state.db = Database(settings)  # lazy: no connection until first query
    # Logs, traces and classifier input are redacted by this one process-wide instance.
    app.state.redactor = Redactor(enabled=settings.redaction_enabled)
    configure_redactor(app.state.redactor)
    app.state.guard = EmergencyGuard()  # loads the shared keyword file: fails fast if missing
    app.state.tracer = tracer or build_tracer(settings)
    app.state.prompts = PromptRegistry()
    app.state.templates = TemplateStore()
    app.state.catalog = catalog or CatalogService.from_settings(
        settings, app.state.db.session_factory
    )
    app.state.pipeline = pipeline or RxPipeline(MinimalPipeline())
    app.state.llm_router = llm_router or _default_llm_router(settings)

    # Last added = outermost: the request id is bound first, then the body limit applies.
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(RequestIdMiddleware)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)

    app.include_router(health.router)
    app.include_router(v1_router)
    return app


def _default_llm_router(settings: Settings) -> LLMRouter:
    """The real/fake router from settings. A misconfigured real mode must not stop the app booting:
    `/health/ready` reports it, and `/v1/process` answers 503 until it is fixed."""
    try:
        return build_llm_router(settings, observer=observe_llm_call)
    except LLMConfigError:
        return _UnconfiguredRouter()  # type: ignore[return-value]


class _UnconfiguredRouter:
    """Stands in for the router when the LLM configuration is invalid."""

    async def generate(self, *_args: object, **_kwargs: object) -> object:
        raise LLMConfigError("LLM configuration is invalid")


async def _http_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)  # noqa: S101 - narrowing for mypy
    code = exc.code if isinstance(exc, ApiError) else None
    body = error_body(exc.status_code, str(exc.detail), current_request_id(), code=code)
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
