"""`GraphPipeline`: the `Pipeline` the endpoint uses since M9. It only runs the compiled LangGraph and
turns the final state into the `PipelineOutput` the endpoint (and the unchanged contract) expects."""

from dataclasses import replace

from app.graph.builder import CompiledGraph, get_graph
from app.graph.state import GraphState
from app.pipeline.base import PipelineContext, PipelineOutput
from app.schemas.process import InputType, Intent, ProcessRequest, Reply, TraceEntry
from app.tools.spoken import build_spoken_text, short_transcript

# Voice replies to these questions start with what we understood, so a wrongly heard drug name or
# test is caught by the user. Not for emergencies (kept instant and simple), commands or chit-chat.
_MEDICAL_QUESTIONS = frozenset({Intent.generic_query, Intent.interaction_query, Intent.lab_report})
MAX_REPLY_CHARS = 4096


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
        detected_command=state.detected_command,
    )


def _with_voice_extras(
    output: PipelineOutput, state: GraphState, ctx: PipelineContext
) -> PipelineOutput:
    """Voice notes only: the redacted transcript, the "you asked" line and the spoken text."""
    if state.request.input.type is not InputType.audio:
        return output
    short = None if output.emergency else short_transcript(state.transcript_redacted)
    reply = output.reply
    if short and output.intent in _MEDICAL_QUESTIONS and state.detected_command is None:
        language = state.request.user.language
        line = ctx.templates.get(language, "voice.you_asked").format(transcript=short)
        text = f"{line}\n\n{reply.text}"
        if len(text) <= MAX_REPLY_CHARS:
            reply = Reply(language=reply.language, text=text, buttons=reply.buttons)
    spoken = build_spoken_text(state, ctx) if state.request.options.want_spoken else None
    return replace(output, reply=reply, transcript_redacted_short=short, spoken_text=spoken)


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
        state = GraphState.model_validate(final)
        return _with_voice_extras(output_from_state(state), state, ctx)
