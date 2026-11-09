"""`GraphPipeline`: the `Pipeline` the endpoint uses since M9. It only runs the compiled LangGraph and
turns the final state into the `PipelineOutput` the endpoint (and the unchanged contract) expects."""

from app.graph.builder import CompiledGraph, get_graph
from app.graph.state import GraphState
from app.pipeline.base import PipelineContext, PipelineOutput
from app.schemas.process import Intent, ProcessRequest, TraceEntry


def trace_entries(state: GraphState) -> list[TraceEntry]:
    """Per-node timings for the demo's trace view. Numbers and names only: no text, no values."""
    return [
        TraceEntry(
            node=t.node,
            latency_ms=t.latency_ms,
            status=t.status,
            model=t.model,
            tokens_in=t.tokens_in or None,
            tokens_out=t.tokens_out or None,
            cost_usd=t.cost_usd or None,
            prompt_version=t.prompt_version,
        )
        for t in state.node_timings
    ]


def output_from_state(state: GraphState) -> PipelineOutput:
    assert state.reply is not None  # noqa: S101 - every path of the graph ends with a reply
    emergency = state.emergency
    is_emergency = bool(emergency and emergency.is_emergency)
    return PipelineOutput(
        intent=state.intent or Intent.other,
        emergency=is_emergency,
        emergency_category=emergency.category if emergency and is_emergency else None,
        reply=state.reply,
        warnings=list(state.warnings),
        extraction=state.lab_extraction or state.rx_extraction,
        interactions=state.interaction_report,
        debug_trace=trace_entries(state),
    )


class GraphPipeline:
    def __init__(self, graph: CompiledGraph | None = None) -> None:
        self._graph = graph

    async def run(self, request: ProcessRequest, ctx: PipelineContext) -> PipelineOutput:
        ctx.usage.add_prompt_version(ctx.templates.version)
        graph = self._graph or get_graph()
        final = await graph.ainvoke(
            GraphState(request=request),
            context=ctx,
            config={"recursion_limit": ctx.settings.graph_recursion_limit},
        )
        return output_from_state(GraphState.model_validate(final))
