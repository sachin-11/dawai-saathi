"""Langfuse tracing: one trace per `/v1/process` request, one generation per LLM call.

PHI rules (CLAUDE.md §2.6, §13):
  * every input/output that leaves the process goes through `redact_value` first (and the Langfuse
    client is also given it as a global `mask`, as a second line of defence)
  * images are NEVER uploaded: traces carry a placeholder such as "[image: image/jpeg, 512 KB]"
  * without Langfuse keys the tracer is a no-op and the app works unchanged
  * tracing can never break a request: every call into the SDK is guarded

The SDK sits behind the small `LangfuseLike` protocol, so tests use a fake client and a change in
the SDK's API touches one adapter.
"""

import hashlib
from contextvars import ContextVar
from typing import Any, Protocol

import structlog

from app.config import Settings
from app.llm.types import LLMCallRecord
from app.safety.redaction import redact_str, redact_value

_logger = structlog.get_logger(__name__)


def trace_id_for(request_id: str) -> str:
    """A stable 32-hex trace id derived from the request id (what Langfuse expects)."""
    return hashlib.sha256(request_id.encode("utf-8")).hexdigest()[:32]


class LangfuseObservation(Protocol):
    def update(self, **kwargs: Any) -> Any: ...
    def end(self, **kwargs: Any) -> Any: ...


class LangfuseLike(Protocol):
    def start_observation(self, **kwargs: Any) -> LangfuseObservation: ...
    def create_trace_id(self, *, seed: str | None = None) -> str: ...
    def flush(self) -> None: ...
    def shutdown(self) -> None: ...


class NodeSpan(Protocol):
    """One graph node inside a trace (M9). LLM generations made while it is open nest under it."""

    def end(self, status: str, details: dict[str, Any]) -> None: ...


class TraceSession(Protocol):
    @property
    def trace_id(self) -> str | None: ...
    def generation(self, record: LLMCallRecord) -> None: ...
    def node_span(self, name: str) -> NodeSpan: ...
    def finish(self, output: dict[str, Any]) -> None: ...


class Tracer(Protocol):
    def start(self, request_id: str, name: str, input_summary: dict[str, Any]) -> TraceSession: ...
    def flush(self) -> None: ...
    def shutdown(self) -> None: ...


# ------------------------------------------------------------------ no-op


class _NoopSpan:
    def end(self, status: str, details: dict[str, Any]) -> None:
        return None


class _NoopSession:
    trace_id: str | None = None

    def generation(self, record: LLMCallRecord) -> None:
        return None

    def node_span(self, name: str) -> NodeSpan:
        return _NoopSpan()

    def finish(self, output: dict[str, Any]) -> None:
        return None


class NoopTracer:
    """Used when Langfuse keys are missing."""

    def start(self, request_id: str, name: str, input_summary: dict[str, Any]) -> TraceSession:
        return _NoopSession()

    def flush(self) -> None:
        return None

    def shutdown(self) -> None:
        return None


# ------------------------------------------------------------------ Langfuse


# Calls whose input/output is (a repair of) the text read from a document: raw OCR lines. A trace only
# gets the prompt (instructions) and a placeholder, never what the model read (CLAUDE.md §13, M9).
_CONTENT_FREE_PREFIXES = ("vision_extract_rx",)


def _is_content_free(record: LLMCallRecord) -> bool:
    return record.name.startswith(_CONTENT_FREE_PREFIXES)


def _describe_messages(record: LLMCallRecord) -> list[dict[str, str]]:
    """Prompt as sent to the model, redacted, with images replaced by a placeholder."""
    messages = [
        m for m in record.messages if not (_is_content_free(record) and m.role == "assistant")
    ]
    described = [{"role": m.role, "content": redact_str(m.content)} for m in messages]
    for image in record.images:
        described.append({"role": "user", "content": image.describe()})
    return described


class _LangfuseSpan:
    def __init__(self, observation: LangfuseObservation | None) -> None:
        self._observation = observation
        self.id: str | None = getattr(observation, "id", None)

    def end(self, status: str, details: dict[str, Any]) -> None:
        if self._observation is None:
            return
        try:
            failed = status in {"error", "timeout"}
            self._observation.update(
                output=redact_value(details),
                level="ERROR" if failed else "DEFAULT",
                status_message=status,
            )
            self._observation.end()
        except Exception:
            _logger.warning("tracing_span_failed")


class _LangfuseSession:
    def __init__(
        self, client: LangfuseLike, trace_id: str, root: LangfuseObservation | None
    ) -> None:
        self._client = client
        self._trace_id = trace_id
        self._root = root

    @property
    def trace_id(self) -> str | None:
        return self._trace_id

    def node_span(self, name: str) -> NodeSpan:
        """A span for one graph node, under the request's root span."""
        try:
            context: dict[str, str] = {"trace_id": self._trace_id}
            root_id = getattr(self._root, "id", None)
            if root_id:
                context["parent_span_id"] = root_id
            observation = self._client.start_observation(
                trace_context=context, name=name, as_type="span"
            )
        except Exception:
            _logger.warning("tracing_span_start_failed")
            return _LangfuseSpan(None)
        span = _LangfuseSpan(observation)
        _current_span_id.set(span.id)
        return span

    def generation(self, record: LLMCallRecord) -> None:
        try:
            context: dict[str, str] = {"trace_id": self._trace_id}
            parent = _current_span_id.get()
            if parent:  # nest under the node that made the call
                context["parent_span_id"] = parent
            observation = self._client.start_observation(
                trace_context=context,
                name=record.name,
                as_type="generation",
                model=record.model,
                input=_describe_messages(record),
                output=(
                    "[structured output omitted: it contains text read from a document]"
                    if _is_content_free(record)
                    else redact_str(record.output_text)
                    if record.output_text is not None
                    else None
                ),
                usage_details={"input": record.input_tokens, "output": record.output_tokens},
                cost_details={"total": record.cost_usd},
                version=record.prompt_version,
                level="DEFAULT" if record.ok else "ERROR",
                status_message=record.error_kind,
                metadata=redact_value(
                    {
                        "provider": record.provider,
                        "attempt": record.attempt,
                        "latency_ms": record.latency_ms,
                        "prompt_version": record.prompt_version,
                    }
                ),
            )
            observation.end()
        except Exception:
            _logger.warning("tracing_generation_failed")

    def finish(self, output: dict[str, Any]) -> None:
        if self._root is None:
            return
        try:
            self._root.update(output=redact_value(output))
            self._root.end()
            self._client.flush()
        except Exception:
            _logger.warning("tracing_finish_failed")


class LangfuseTracer:
    def __init__(self, client: LangfuseLike) -> None:
        self._client = client

    def start(self, request_id: str, name: str, input_summary: dict[str, Any]) -> TraceSession:
        try:
            trace_id = self._client.create_trace_id(seed=request_id)
            root = self._client.start_observation(
                trace_context={"trace_id": trace_id},
                name=name,
                as_type="span",
                input=redact_value(input_summary),
                metadata={"request_id": request_id},
            )
        except Exception:
            _logger.warning("tracing_start_failed")
            return _NoopSession()
        return _LangfuseSession(self._client, trace_id, root)

    def flush(self) -> None:
        try:
            self._client.flush()
        except Exception:
            _logger.warning("tracing_flush_failed")

    def shutdown(self) -> None:
        try:
            self._client.shutdown()
        except Exception:
            _logger.warning("tracing_shutdown_failed")


def build_tracer(settings: Settings, client: LangfuseLike | None = None) -> Tracer:
    """Langfuse when both keys are set (or a client is injected, for tests), otherwise a no-op."""
    if client is not None:
        return LangfuseTracer(client)
    if not settings.langfuse_enabled:
        return NoopTracer()

    from langfuse import Langfuse  # imported lazily: the SDK is only needed when tracing is on

    def mask(*, data: Any, **_kwargs: Any) -> Any:
        return redact_value(data)

    public_key = settings.langfuse_public_key
    secret_key = settings.langfuse_secret_key
    if public_key is None or secret_key is None:
        return NoopTracer()
    real = Langfuse(
        public_key=public_key.get_secret_value(),
        secret_key=secret_key.get_secret_value(),
        host=settings.langfuse_host,
        mask=mask,
    )
    return LangfuseTracer(real)  # type: ignore[arg-type]  # SDK signatures are wider than the protocol


# ------------------------------------------------------------------ per-request wiring

_current_session: ContextVar[TraceSession | None] = ContextVar("trace_session", default=None)
_current_span_id: ContextVar[str | None] = ContextVar("trace_span_id", default=None)


def current_session() -> TraceSession | None:
    return _current_session.get()


def clear_current_span() -> None:
    """Called when a node ends: later LLM calls (outside any node) nest under the root again."""
    _current_span_id.set(None)


def bind_session(session: TraceSession) -> None:
    _current_session.set(session)


def observe_llm_call(record: LLMCallRecord) -> None:
    """The router's observer: forwards each LLM attempt to the current request's trace (if any)."""
    session = _current_session.get()
    if session is not None:
        session.generation(record)
