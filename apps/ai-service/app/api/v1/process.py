"""POST /v1/process: the single entry point the gateway calls (CLAUDE.md §8.1)."""

import asyncio
import time

import structlog
from fastapi import APIRouter, Depends, Request

from app.api.auth import require_service_token
from app.api.errors import ApiError, api_error_from_llm
from app.config import Settings
from app.llm.router import Deadline, LLMRouter
from app.llm.types import LLMError
from app.observability.tracing import Tracer, bind_session
from app.pipeline.base import Pipeline, PipelineContext, RequestUsage
from app.prompts.registry import PromptRegistry, TemplateStore
from app.schemas.process import Meta, ProcessRequest, ProcessResponse

router = APIRouter(prefix="/v1", tags=["process"])
log = structlog.get_logger("process")


def _input_summary(request: ProcessRequest) -> dict[str, object]:
    """What a trace shows about the input: type and language only. The text itself is redacted by
    the tracer, and media is never included (only its type)."""
    summary: dict[str, object] = {
        "input_type": request.input.type.value,
        "language": request.user.language.value,
    }
    if request.input.text is not None:
        summary["text"] = request.input.text
    if request.input.mime is not None:
        summary["media"] = f"[{request.input.mime}]"
    return summary


@router.post(
    "/process",
    response_model=ProcessResponse,
    dependencies=[Depends(require_service_token)],
    responses={
        401: {"description": "Missing or wrong X-Service-Token"},
        413: {"description": "Request body too large"},
        422: {"description": "Invalid request"},
        502: {"description": "The language model failed or returned an unusable answer"},
        503: {"description": "The language model is unavailable or not configured"},
        504: {"description": "Processing took longer than PROCESS_TIMEOUT_S"},
    },
)
async def process(body: ProcessRequest, request: Request) -> ProcessResponse:
    """Run one message through the pipeline and return a structured, WhatsApp-ready reply."""
    state = request.app.state
    settings: Settings = state.settings
    llm: LLMRouter = state.llm_router
    pipeline: Pipeline = state.pipeline
    tracer: Tracer = state.tracer
    prompts: PromptRegistry = state.prompts
    templates: TemplateStore = state.templates

    # The id from the body is the one the gateway correlates with: bind it for every log line.
    structlog.contextvars.bind_contextvars(request_id=body.request_id)
    started = time.perf_counter()
    session = tracer.start(body.request_id, "process", _input_summary(body))
    bind_session(session)

    usage = RequestUsage()
    ctx = PipelineContext(
        settings=settings,
        router=llm,
        prompts=prompts,
        templates=templates,
        deadline=Deadline(settings.process_timeout_s),
        usage=usage,
        guard=state.guard,
        redactor=state.redactor,
        catalog=state.catalog,
    )
    try:
        async with asyncio.timeout(settings.process_timeout_s):
            output = await pipeline.run(body, ctx)
    except TimeoutError:
        session.finish({"error": "PROCESS_TIMEOUT"})
        raise ApiError(504, "PROCESS_TIMEOUT", "Processing took too long") from None
    except LLMError as error:
        session.finish({"error": error.kind})
        raise api_error_from_llm(error) from None

    latency_ms = round((time.perf_counter() - started) * 1000)
    meta = Meta(
        model=usage.model,
        prompt_version=",".join(usage.prompt_versions),
        latency_ms=latency_ms,
        cost_usd=round(usage.cost_usd, 6),
        trace_id=session.trace_id,
        provider=usage.provider,
        fallback_used=usage.fallback_used,
    )
    session.finish(
        {
            "intent": output.intent.value,
            "emergency": output.emergency,
            "latency_ms": latency_ms,
            "cost_usd": meta.cost_usd,
            "fallback_used": meta.fallback_used,
        }
    )
    # Numbers and ids only: never the message text or the reply.
    log.info(
        "process_done",
        intent=output.intent.value,
        emergency=output.emergency,
        model=meta.model,
        provider=meta.provider,
        fallback_used=meta.fallback_used,
        latency_ms=latency_ms,
        cost_usd=meta.cost_usd,
        trace_id=meta.trace_id,
    )
    return ProcessResponse(
        request_id=body.request_id,
        intent=output.intent,
        emergency=output.emergency,
        emergency_category=output.emergency_category,
        extraction=output.extraction,
        warnings=output.warnings,
        reply=output.reply,
        meta=meta,
    )


__all__ = ["router"]
