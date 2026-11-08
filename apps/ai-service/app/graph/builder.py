"""Build and compile the LangGraph state machine (M9, CLAUDE.md §8.2).

A CONTROLLED graph, not a free-roaming agent: every edge is declared here, the model never chooses
the next step, the recursion limit is explicit and the extraction retry is counted in the state.
There is deliberately no checkpointer: the service is stateless per request (CLAUDE.md §4).
"""

from functools import lru_cache

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from app.graph import routing as r
from app.graph.nodes.classify import classify
from app.graph.nodes.composer import composer
from app.graph.nodes.emergency_guard import emergency_classifier, emergency_guard
from app.graph.nodes.interaction_nodes import (
    extract_interaction_query,
    interaction_check,
    match_query_medicines,
)
from app.graph.nodes.prepare_image import prepare_image
from app.graph.nodes.redact import redact
from app.graph.nodes.rx_nodes import (
    confidence_gate,
    extract_query,
    generic_finder,
    normalize_drugs,
    validate_rx,
    vision_extract_rx,
)
from app.graph.nodes.templates import rx_fallback_renderer, templates
from app.graph.nodes.transcribe import transcribe
from app.graph.nodes.verifier import verifier
from app.graph.state import GraphState
from app.pipeline.base import PipelineContext

CompiledGraph = CompiledStateGraph[GraphState, PipelineContext, GraphState, GraphState]


def build_graph() -> CompiledGraph:
    graph = StateGraph(GraphState, context_schema=PipelineContext)
    for name, node in (
        (r.EMERGENCY_GUARD, emergency_guard),
        (r.REDACT, redact),
        (r.EMERGENCY_CLASSIFIER, emergency_classifier),
        (r.TRANSCRIBE, transcribe),
        (r.PREPARE_IMAGE, prepare_image),
        (r.CLASSIFY, classify),
        (r.VISION_EXTRACT_RX, vision_extract_rx),
        (r.VALIDATE_RX, validate_rx),
        (r.NORMALIZE_DRUGS, normalize_drugs),
        (r.GENERIC_FINDER, generic_finder),
        (r.CONFIDENCE_GATE, confidence_gate),
        (r.EXTRACT_QUERY, extract_query),
        (r.EXTRACT_INTERACTION_QUERY, extract_interaction_query),
        (r.MATCH_QUERY_MEDICINES, match_query_medicines),
        (r.INTERACTION_CHECK, interaction_check),
        (r.COMPOSER, composer),
        (r.VERIFIER, verifier),
        (r.TEMPLATES, templates),
        (r.RX_FALLBACK, rx_fallback_renderer),
    ):
        graph.add_node(name, node)

    # Entry: typed text is guarded; a file is prepared; audio waits for M13.
    graph.add_conditional_edges(
        START,
        r.route_input,
        {
            r.EMERGENCY_GUARD: r.EMERGENCY_GUARD,
            r.PREPARE_IMAGE: r.PREPARE_IMAGE,
            r.TRANSCRIBE: r.TRANSCRIBE,
        },
    )
    graph.add_conditional_edges(
        r.EMERGENCY_GUARD, r.after_emergency_guard, {r.REDACT: r.REDACT, r.TEMPLATES: r.TEMPLATES}
    )
    graph.add_edge(r.REDACT, r.EMERGENCY_CLASSIFIER)
    graph.add_conditional_edges(
        r.EMERGENCY_CLASSIFIER,
        r.after_emergency_classifier,
        {r.CLASSIFY: r.CLASSIFY, r.TEMPLATES: r.TEMPLATES},
    )
    graph.add_edge(r.TRANSCRIBE, r.TEMPLATES)  # M13 placeholder
    graph.add_conditional_edges(
        r.PREPARE_IMAGE, r.after_prepare_image, {r.CLASSIFY: r.CLASSIFY, r.TEMPLATES: r.TEMPLATES}
    )
    graph.add_conditional_edges(
        r.CLASSIFY,
        r.after_classify,
        {
            r.VISION_EXTRACT_RX: r.VISION_EXTRACT_RX,
            r.EXTRACT_QUERY: r.EXTRACT_QUERY,
            r.EXTRACT_INTERACTION_QUERY: r.EXTRACT_INTERACTION_QUERY,
            r.TEMPLATES: r.TEMPLATES,
        },
    )
    graph.add_conditional_edges(
        r.VISION_EXTRACT_RX,
        r.after_vision_extract,
        {
            r.VALIDATE_RX: r.VALIDATE_RX,
            r.VISION_EXTRACT_RX: r.VISION_EXTRACT_RX,
            r.TEMPLATES: r.TEMPLATES,
        },
    )
    graph.add_edge(r.VALIDATE_RX, r.NORMALIZE_DRUGS)
    graph.add_conditional_edges(
        r.EXTRACT_QUERY,
        r.after_extract_query,
        {r.NORMALIZE_DRUGS: r.NORMALIZE_DRUGS, r.TEMPLATES: r.TEMPLATES},
    )
    graph.add_conditional_edges(
        r.NORMALIZE_DRUGS,
        r.after_normalize_drugs,
        {r.GENERIC_FINDER: r.GENERIC_FINDER, r.TEMPLATES: r.TEMPLATES},
    )
    graph.add_conditional_edges(
        r.GENERIC_FINDER,
        r.after_generic_finder,
        {
            r.INTERACTION_CHECK: r.INTERACTION_CHECK,
            r.COMPOSER: r.COMPOSER,
            r.TEMPLATES: r.TEMPLATES,
        },
    )
    graph.add_conditional_edges(
        r.EXTRACT_INTERACTION_QUERY,
        r.after_extract_interaction_query,
        {r.MATCH_QUERY_MEDICINES: r.MATCH_QUERY_MEDICINES, r.TEMPLATES: r.TEMPLATES},
    )
    graph.add_conditional_edges(
        r.MATCH_QUERY_MEDICINES,
        r.after_match_query_medicines,
        {r.INTERACTION_CHECK: r.INTERACTION_CHECK, r.TEMPLATES: r.TEMPLATES},
    )
    graph.add_conditional_edges(
        r.INTERACTION_CHECK,
        r.after_interaction_check,
        {r.CONFIDENCE_GATE: r.CONFIDENCE_GATE, r.COMPOSER: r.COMPOSER, r.TEMPLATES: r.TEMPLATES},
    )
    graph.add_conditional_edges(
        r.CONFIDENCE_GATE,
        r.after_confidence_gate,
        {r.COMPOSER: r.COMPOSER, r.TEMPLATES: r.TEMPLATES},
    )
    graph.add_edge(r.COMPOSER, r.VERIFIER)
    graph.add_conditional_edges(
        r.VERIFIER, r.after_verifier, {END: END, r.RX_FALLBACK: r.RX_FALLBACK}
    )
    graph.add_edge(r.TEMPLATES, END)
    graph.add_edge(r.RX_FALLBACK, END)
    return graph.compile()


@lru_cache(maxsize=1)
def get_graph() -> CompiledGraph:
    """The compiled graph is immutable and holds no request data: one per process."""
    return build_graph()
