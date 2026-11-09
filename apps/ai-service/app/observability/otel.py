"""OpenTelemetry for the AI service (M15, CLAUDE.md §13).

One trace per inbound WhatsApp message: the gateway sends a W3C `traceparent` with its HTTP call, the
FastAPI instrumentation continues that trace, and every graph node adds a child span.

PHI rules (CLAUDE.md §2.6):
  * `ScrubbingExporter` is the LAST step before export. A span attribute leaves the process only when
    its key is on `ALLOWED_ATTRIBUTES` (or starts with `dawai.`) AND its value is a short primitive
    that does not look like a phone number or an e-mail. Event attributes (exception messages!) and
    status descriptions are dropped. URLs (presigned S3 links carry signatures) are never exported.
  * we only ever put ids, types, statuses, codes, sizes, latencies, model names and costs into
    `dawai.*` attributes; the allowlist is the second line of defence, a unit test the third.

Sampling: `TailSamplingProcessor` keeps 100% of traces that contain an error or an emergency and
`OTEL_SAMPLE_RATIO` of the rest. The ratio decision is a pure function of the trace id, so the
gateway and this service agree on it without talking to each other.
"""

import re
import threading
import time
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from typing import Final

import structlog
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.trace import StatusCode

from app.config import Settings

_logger = structlog.get_logger(__name__)

# Keys that may leave the process. Anything starting with `dawai.` is ours and also allowed.
ALLOWED_ATTRIBUTES: Final = frozenset(
    {
        "http.method",
        "http.request.method",
        "http.status_code",
        "http.response.status_code",
        "http.route",
        "http.flavor",
        "db.system",
        "db.operation",
        "error.type",
        "exception.type",
        "service.name",
    }
)
ALLOWED_PREFIXES: Final = ("dawai.",)
EMERGENCY_ATTRIBUTE: Final = "dawai.emergency"
MAX_VALUE_LENGTH: Final = 128

_PHONE_LIKE: Final = re.compile(r"(?:\+?\d[\s-]?){10,}")
_EMAIL_LIKE: Final = re.compile(r"\S+@\S+\.\S+")


_NUMBER_ONLY: Final = re.compile(r"[+\d\s\-()]+")


def _value_is_safe(value: object) -> bool:
    if isinstance(value, bool | int | float):
        return True
    if not isinstance(value, str) or len(value) > MAX_VALUE_LENGTH:
        return False
    if _EMAIL_LIKE.search(value):
        return False
    # An id (hex trace id, uuid, wamid.xxx) is a single token with letters: never a phone number.
    # A phone number is digits-only, or hides in free text (a value with spaces).
    looks_like_text = " " in value or _NUMBER_ONLY.fullmatch(value) is not None
    return not (looks_like_text and _PHONE_LIKE.search(value))


def scrub_attributes(attributes: Mapping[str, object] | None) -> dict[str, object]:
    """Keep only allowlisted keys with short, harmless primitive values."""
    if not attributes:
        return {}
    kept: dict[str, object] = {}
    for key, value in attributes.items():
        if key not in ALLOWED_ATTRIBUTES and not key.startswith(ALLOWED_PREFIXES):
            continue
        if _value_is_safe(value):
            kept[key] = value
    return kept


class ScrubbingExporter(SpanExporter):
    """Wraps a real exporter; every span is rebuilt with scrubbed attributes first."""

    def __init__(self, inner: SpanExporter) -> None:
        self._inner = inner

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._inner.export([_scrubbed(span) for span in spans])

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


def _scrubbed(span: ReadableSpan) -> ReadableSpan:
    status = span.status
    if status.description:
        status = trace.Status(status.status_code)  # the description may quote an error message
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=scrub_attributes(span.attributes),  # type: ignore[arg-type]
        events=(),  # exception events carry messages and stack traces
        links=span.links,
        kind=span.kind,
        instrumentation_scope=span.instrumentation_scope,
        status=status,
        start_time=span.start_time,
        end_time=span.end_time,
    )


def ratio_keeps(trace_id: int, ratio: float) -> bool:
    """Deterministic: the same trace id gives the same answer in every service."""
    if ratio >= 1.0:
        return True
    if ratio <= 0.0:
        return False
    return (trace_id & 0xFFFFFFFFFFFFFFFF) / float(1 << 64) < ratio


def _is_important(span: ReadableSpan) -> bool:
    if span.status.status_code is StatusCode.ERROR:
        return True
    return bool(span.attributes and span.attributes.get(EMERGENCY_ATTRIBUTE) is True)


class TailSamplingProcessor(SpanProcessor):
    """Buffers the spans of a trace until its local root ends, then keeps or drops them together."""

    def __init__(
        self,
        inner: SpanProcessor,
        ratio: float,
        *,
        max_traces: int = 2000,
        max_age_s: float = 120.0,
    ) -> None:
        self._inner = inner
        self._ratio = ratio
        self._max_traces = max_traces
        self._max_age_s = max_age_s
        self._lock = threading.Lock()
        self._buffers: OrderedDict[int, tuple[float, list[ReadableSpan]]] = OrderedDict()

    def on_start(self, span: object, parent_context: object = None) -> None:
        return None

    def on_end(self, span: ReadableSpan) -> None:
        trace_id = span.context.trace_id
        is_local_root = span.parent is None or span.parent.is_remote
        with self._lock:
            _started, spans = self._buffers.setdefault(trace_id, (time.monotonic(), []))
            spans.append(span)
            ready: list[tuple[int, list[ReadableSpan]]] = []
            if is_local_root:
                self._buffers.pop(trace_id, None)
                ready.append((trace_id, spans))
            else:
                self._buffers.move_to_end(trace_id)
            ready.extend(self._evict(time.monotonic()))
        for tid, group in ready:
            self._decide(tid, group)

    def _evict(self, now: float) -> list[tuple[int, list[ReadableSpan]]]:
        out: list[tuple[int, list[ReadableSpan]]] = []
        while self._buffers:
            tid, (started, spans) = next(iter(self._buffers.items()))
            if len(self._buffers) <= self._max_traces and now - started <= self._max_age_s:
                break
            self._buffers.pop(tid)
            out.append((tid, spans))
        return out

    def _decide(self, trace_id: int, spans: list[ReadableSpan]) -> None:
        if ratio_keeps(trace_id, self._ratio) or any(_is_important(s) for s in spans):
            for span in spans:
                self._inner.on_end(span)

    def shutdown(self) -> None:
        with self._lock:
            remaining = list(self._buffers.items())
            self._buffers.clear()
        for tid, (_, spans) in remaining:
            self._decide(tid, spans)
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


def build_provider(
    settings: Settings, exporter: SpanExporter | None = None, *, batch: bool = True
) -> TracerProvider | None:
    """A provider that records everything and lets the tail sampler decide. None = tracing off."""
    if exporter is None:
        if settings.otel_exporter_otlp_endpoint is None:
            return None
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        endpoint = settings.otel_exporter_otlp_endpoint.rstrip("/")
        exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")
    resource = Resource.create(
        {"service.name": "ai-service", "deployment.environment": settings.environment}
    )
    provider = TracerProvider(resource=resource)
    scrubbing = ScrubbingExporter(exporter)
    sink: SpanProcessor = BatchSpanProcessor(scrubbing) if batch else SimpleSpanProcessor(scrubbing)
    provider.add_span_processor(TailSamplingProcessor(sink, settings.otel_sample_ratio))
    return provider


_installed = False


def install_otel(settings: Settings, app: object | None = None) -> TracerProvider | None:
    """Set the global provider once and instrument FastAPI / httpx / SQLAlchemy / asyncpg."""
    global _installed
    if _installed:
        return None
    provider = build_provider(settings)
    if provider is None:
        return None
    trace.set_tracer_provider(provider)
    from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

    HTTPXClientInstrumentor().instrument()
    SQLAlchemyInstrumentor().instrument(enable_commenter=False)
    AsyncPGInstrumentor().instrument()  # type: ignore[no-untyped-call]
    _installed = True
    _logger.info("otel_installed", sample_ratio=settings.otel_sample_ratio)
    return provider


def instrument_app(app: object, settings: Settings) -> None:
    if settings.otel_exporter_otlp_endpoint is None:
        return
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(
        app,  # type: ignore[arg-type]
        excluded_urls="/metrics,/health/.*",
    )


def get_tracer() -> trace.Tracer:
    return trace.get_tracer("dawai.ai-service")


def current_trace_ids() -> tuple[str | None, str | None]:
    ctx = trace.get_current_span().get_span_context()
    if not ctx.is_valid:
        return None, None
    return format(ctx.trace_id, "032x"), format(ctx.span_id, "016x")


def add_trace_context(
    _logger: object, _method: str, event_dict: structlog.typing.EventDict
) -> structlog.typing.EventDict:
    """structlog processor: put trace_id / span_id on every log line inside a span."""
    trace_id, span_id = current_trace_ids()
    if trace_id is not None:
        event_dict["trace_id"] = trace_id
        event_dict["span_id"] = span_id
    return event_dict


def mark_current_span(**attributes: object) -> None:
    """Set `dawai.*` attributes on the active span (no-op without one)."""
    span = trace.get_current_span()
    if not span.is_recording():
        return
    for key, value in attributes.items():
        if _value_is_safe(value):
            span.set_attribute(f"dawai.{key}", value)  # type: ignore[arg-type]
