"""`@traced_node`: the one wrapper every graph node goes through (M9, CLAUDE.md §13).

For each node run it
  * enforces the node's time limit (never longer than what is left of the request's deadline)
  * opens a span in the request's trace; LLM generations made inside nest under it
  * writes ONE structured log line (node, latency_ms, status): no content, request_id is bound
  * feeds the in-process metrics (latency histogram, error and fallback counters)
  * appends a `NodeTiming` (latency, tokens, cost, model, prompt version) and the cost delta to the state

A node that cannot recover lets its exception through (the endpoint maps it); a node that can
recover declares `on_timeout`, a pure function returning the partial update to use instead.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import structlog
from langgraph.runtime import Runtime
from opentelemetry.trace import StatusCode

from app.graph.errors import NodeTimeoutError
from app.graph.state import GraphState, NodeError, NodeStatus, NodeTiming
from app.llm.types import LLMError
from app.observability.metrics import METRICS
from app.observability.otel import get_tracer
from app.observability.tracing import clear_current_span, current_session
from app.pipeline.base import PipelineContext

log = structlog.get_logger("graph")

NodeFn = Callable[[GraphState, PipelineContext], Awaitable[dict[str, Any]]]
FallbackFn = Callable[[GraphState, PipelineContext], dict[str, Any]]


class GraphNode(Protocol):
    """What LangGraph calls: the state, and the request's runtime context by keyword."""

    async def __call__(
        self, state: GraphState, *, runtime: Runtime[PipelineContext]
    ) -> dict[str, Any]: ...


# Nodes that never stop for the per-request cost cap: they are free (no model) or safety-critical.
COST_CAP_EXEMPT = frozenset(
    {
        "emergency_guard",
        "emergency_classifier",
        "redact",
        "composer",
        "templates",
        "rx_fallback",
        "verifier",
    }
)

# A node may return {"_status": "fallback"} to say it recovered on its own (e.g. template reply).
STATUS_KEY = "_status"


def _error_code(error: BaseException) -> str:
    return error.kind if isinstance(error, LLMError) else type(error).__name__


def _over_cost_cap(name: str, timeout: str, spent: float, ctx: PipelineContext) -> bool:
    """M15: stop BEFORE a node that would push the request past MAX_COST_PER_REQUEST_USD."""
    cap = ctx.settings.max_cost_per_request_usd
    if cap is None or name in COST_CAP_EXEMPT:
        return False
    projected = spent + (ctx.settings.cost_estimate_vision_usd if timeout == "vision" else 0.0)
    return projected > cap


def traced_node(
    name: str, *, timeout: str = "fast", on_timeout: FallbackFn | None = None
) -> Callable[[NodeFn], GraphNode]:
    """`timeout` is a node class: vision | cheap | composer | io | fast (see Settings.node_timeout_s)."""

    def decorator(fn: NodeFn) -> GraphNode:
        async def wrapper(
            state: GraphState, *, runtime: Runtime[PipelineContext]
        ) -> dict[str, Any]:
            ctx = runtime.context
            session = current_session()
            span = session.node_span(name) if session is not None else None
            usage = ctx.usage
            cost0, in0, out0 = usage.cost_usd, usage.input_tokens, usage.output_tokens
            versions0 = len(usage.prompt_versions)
            started = time.perf_counter()
            limit = min(ctx.settings.node_timeout_s(timeout), ctx.deadline.remaining())
            otel_span = get_tracer().start_span(f"graph.{name}", attributes={"dawai.node": name})
            status: NodeStatus = "ok"
            update: dict[str, Any] = {}
            extra_errors: list[NodeError] = []
            failure: BaseException | None = None
            try:
                if limit <= 0:
                    raise TimeoutError
                if _over_cost_cap(name, timeout, usage.cost_usd, ctx):
                    METRICS.budget_limited(ctx.budget_label, "request_cap")
                    update = {"template_key": "budget.too_big"}
                else:
                    async with asyncio.timeout(limit):
                        update = await fn(state, ctx)
                if update.pop(STATUS_KEY, None) == "fallback":
                    status = "fallback"
            except TimeoutError:
                METRICS.count_error(name, "timeout")
                if on_timeout is None:
                    status, failure = "timeout", NodeTimeoutError(name)
                else:
                    status = "fallback"
                    update = on_timeout(state, ctx)
                    update.pop(STATUS_KEY, None)
                    extra_errors.append(NodeError(node=name, code="timeout"))
                    METRICS.count_fallback(f"{name}_timeout")
            except Exception as error:
                status, failure = "error", error
                METRICS.count_error(name, _error_code(error))

            latency_ms = round((time.perf_counter() - started) * 1000)
            METRICS.observe_node(name, latency_ms)
            made_call = (usage.input_tokens, usage.output_tokens, usage.cost_usd) != (
                in0,
                out0,
                cost0,
            )
            timing = NodeTiming(
                node=name,
                latency_ms=latency_ms,
                status=status,
                model=usage.model if made_call else None,
                tokens_in=usage.input_tokens - in0,
                tokens_out=usage.output_tokens - out0,
                cost_usd=round(usage.cost_usd - cost0, 6),
                prompt_version=",".join(usage.prompt_versions[versions0:]) or None,
            )
            log.info("graph_node", node=name, latency_ms=latency_ms, status=status)
            if span is not None:
                span.end(
                    status,
                    {
                        "latency_ms": latency_ms,
                        "tokens_in": timing.tokens_in,
                        "tokens_out": timing.tokens_out,
                    },
                )
            clear_current_span()
            otel_span.set_attribute("dawai.node.status", status)
            otel_span.set_attribute("dawai.node.latency_ms", latency_ms)
            otel_span.set_attribute("dawai.node.cost_usd", timing.cost_usd)
            if timing.model:
                otel_span.set_attribute("dawai.node.model", timing.model)
            if failure is not None or status in ("error", "timeout"):
                otel_span.set_status(StatusCode.ERROR)
                otel_span.set_attribute("error.type", _error_code(failure) if failure else status)
            otel_span.end()
            if failure is not None:
                raise failure

            update["node_timings"] = [*update.get("node_timings", []), timing]
            update["cost_usd"] = update.get("cost_usd", 0.0) + timing.cost_usd
            if extra_errors:
                update["errors"] = [*update.get("errors", []), *extra_errors]
            return update

        # Deliberately NOT functools.wraps: it would make LangGraph read `fn`'s signature (no `runtime`).
        wrapper.__name__ = fn.__name__
        wrapper.__qualname__ = fn.__qualname__
        wrapper.__doc__ = fn.__doc__
        return wrapper

    return decorator
