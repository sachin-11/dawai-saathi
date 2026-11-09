"""Capture what the service LOGS and what it would send to a TRACE backend, to scan for PHI.

M14 hard gate "PHI leakage in extraction/logs/traces = 0": the extraction and the reply were already
scanned by the suites; this adds the other two places. Logs are captured with a handler on the root
logger (same JSON formatter the service uses). Traces go through the REAL `LangfuseTracer` into a
recording client, so every field the Langfuse adapter would upload is visible here, after the service's
own masking.
"""

import logging
from typing import Any

from app.observability.logging import configure_logging
from app.observability.tracing import (
    LangfuseTracer,
    TraceSession,
    bind_session,
    observe_llm_call,
)


class _Handler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


class _Observation:
    id = "obs"

    def __init__(self, sink: list[str], kwargs: dict[str, Any]) -> None:
        self._sink = sink
        self._sink.append(repr(kwargs))

    def update(self, **kwargs: Any) -> None:
        self._sink.append(repr(kwargs))

    def end(self, **kwargs: Any) -> None:
        self._sink.append(repr(kwargs))


class RecordingLangfuse:
    """Implements `LangfuseLike`; stores everything handed to it."""

    def __init__(self) -> None:
        self.records: list[str] = []

    def start_observation(self, **kwargs: Any) -> _Observation:
        return _Observation(self.records, kwargs)

    def create_trace_id(self, *, seed: str | None = None) -> str:
        return f"trace-{seed}"

    def flush(self) -> None:
        return None

    def shutdown(self) -> None:
        return None


class Tap:
    """Install once per suite run. `begin(request_id)` per case, `since(mark)` to read."""

    def __init__(self) -> None:
        configure_logging("info")
        root = logging.getLogger()
        self._handler = _Handler()
        if root.handlers:
            self._handler.setFormatter(root.handlers[0].formatter)
        root.handlers = [self._handler]  # captured, not printed
        self._langfuse = RecordingLangfuse()
        self._tracer = LangfuseTracer(self._langfuse)
        self._session: TraceSession | None = None

    observer = staticmethod(observe_llm_call)

    def begin(self, request_id: str) -> tuple[int, int]:
        mark = (len(self._handler.lines), len(self._langfuse.records))
        self._session = self._tracer.start(request_id, "process", {"input": "eval"})
        bind_session(self._session)
        return mark

    def end(self) -> None:
        if self._session is not None:
            self._session.finish({"intent": "eval"})

    def logs_since(self, mark: tuple[int, int]) -> str:
        return "\n".join(self._handler.lines[mark[0] :])

    def traces_since(self, mark: tuple[int, int]) -> str:
        return "\n".join(self._langfuse.records[mark[1] :])


def leaked(secrets: list[str], haystack: str) -> list[str]:
    """Which secrets appear in the text (case-insensitive). Callers record the count, never the secret."""
    lowered = haystack.casefold()
    return [s for s in secrets if s and s.casefold() in lowered]
