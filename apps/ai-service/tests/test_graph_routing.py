"""Every conditional edge of the graph, as a table: state -> next node (M9). The routing functions are
pure, so none of this needs a model, a database or a running graph."""

import pytest
from langgraph.graph import END

from app.graph import routing as r
from app.graph.builder import build_graph
from app.graph.state import GraphState, VerificationResult
from app.schemas.prescription import PrescriptionExtraction
from app.schemas.process import Intent, ProcessRequest
from tests.rx_support import extraction, image_request


def req(kind: str) -> ProcessRequest:
    if kind == "image":
        return image_request()
    base = {
        "request_id": "wamid.r1",
        "user": {"language": "en"},
        "input": {"type": "text", "text": "hello"},
    }
    if kind == "audio":
        base["input"] = {
            "type": "audio",
            "media_url": "http://localhost:9000/x",
            "mime": "audio/ogg",
        }
    return ProcessRequest.model_validate(base)


def state(kind: str = "text", **fields) -> GraphState:
    return GraphState(request=req(kind), **fields)


EXTRACTION = PrescriptionExtraction.model_validate(extraction())


class TestInput:
    @pytest.mark.parametrize(
        ("kind", "expected"),
        [("text", r.EMERGENCY_GUARD), ("image", r.PREPARE_IMAGE), ("audio", r.TRANSCRIBE)],
    )
    def test_each_input_type_has_one_way_in(self, kind, expected):
        assert r.route_input(state(kind)) == expected

    def test_an_image_never_reaches_the_emergency_nodes(self):
        """Words written on a document are history, not a message from the user (CLAUDE.md §2.2)."""
        for fields in ({}, {"redacted_text": "chest pain"}, {"image_kind": "prescription"}):
            assert r.route_input(state("image", **fields)) not in {
                r.EMERGENCY_GUARD,
                r.REDACT,
                r.EMERGENCY_CLASSIFIER,
            }

    def test_nothing_after_the_entry_leads_back_to_the_emergency_nodes_for_an_image(self):
        """Structural proof: the emergency nodes are reachable only from START (text), redact, and each other."""
        graph = build_graph().get_graph()
        into_guard = {e.source for e in graph.edges if e.target == r.EMERGENCY_GUARD}
        into_redact = {e.source for e in graph.edges if e.target == r.REDACT}
        into_classifier = {e.source for e in graph.edges if e.target == r.EMERGENCY_CLASSIFIER}
        assert into_guard == {"__start__"}
        assert into_redact == {r.EMERGENCY_GUARD}
        assert into_classifier == {r.REDACT}


class TestEdges:
    @pytest.mark.parametrize(
        ("fn", "fields", "expected"),
        [
            # emergency_guard: a template key (the emergency text) ends the request
            (r.after_emergency_guard, {}, r.REDACT),
            (r.after_emergency_guard, {"template_key": "emergency.general"}, r.TEMPLATES),
            (r.after_emergency_classifier, {}, r.CLASSIFY),
            (r.after_emergency_classifier, {"template_key": "emergency.self_harm"}, r.TEMPLATES),
            # prepare_image: an unusable file is a static reply
            (r.after_prepare_image, {}, r.CLASSIFY),
            (r.after_prepare_image, {"template_key": "rx.resend_blur"}, r.TEMPLATES),
            # classify
            (
                r.after_classify,
                {"image_kind": "prescription", "intent": Intent.prescription},
                r.VISION_EXTRACT_RX,
            ),
            (r.after_classify, {"intent": Intent.generic_query}, r.EXTRACT_QUERY),
            (r.after_classify, {"template_key": "help", "intent": Intent.help}, r.TEMPLATES),
            (
                r.after_classify,
                {"template_key": "rx.lab_report", "image_kind": "lab_report"},
                r.TEMPLATES,
            ),
            (
                r.after_classify,
                {"template_key": "coming_soon", "intent": Intent.interaction_query},
                r.TEMPLATES,
            ),
            (r.after_classify, {"intent": Intent.other}, r.TEMPLATES),  # safety net
            # extract_query / normalize_drugs
            (r.after_extract_query, {"query_name": "Dolo 650"}, r.NORMALIZE_DRUGS),
            (r.after_extract_query, {"template_key": "generic_query_ask_name"}, r.TEMPLATES),
            (r.after_normalize_drugs, {}, r.GENERIC_FINDER),
            (r.after_normalize_drugs, {"template_key": "generic_query_unavailable"}, r.TEMPLATES),
            # generic_finder: the typed query skips the gate
            (r.after_generic_finder, {"intent": Intent.generic_query}, r.COMPOSER),
            (r.after_generic_finder, {"intent": Intent.prescription}, r.CONFIDENCE_GATE),
            (r.after_generic_finder, {"template_key": "generic_query_unavailable"}, r.TEMPLATES),
            # confidence_gate
            (r.after_confidence_gate, {}, r.COMPOSER),
            (r.after_confidence_gate, {"template_key": "rx.unreadable"}, r.TEMPLATES),
            # verifier
            (r.after_verifier, {"verification": VerificationResult(ok=True)}, END),
            (
                r.after_verifier,
                {"verification": VerificationResult(ok=False, failures=["name_missing"])},
                r.RX_FALLBACK,
            ),
            (r.after_verifier, {}, r.RX_FALLBACK),  # no verdict is never "ok"
        ],
    )
    def test_next_node(self, fn, fields, expected):
        assert fn(state(**fields)) == expected


class TestTheExtractionRetry:
    """At most ONE retry, guaranteed by the counter in the state."""

    @pytest.mark.parametrize(
        ("fields", "expected"),
        [
            ({"rx_extraction": EXTRACTION, "retries": {r.VISION_EXTRACT_RX: 1}}, r.VALIDATE_RX),
            ({"rx_extraction": None, "retries": {r.VISION_EXTRACT_RX: 1}}, r.VISION_EXTRACT_RX),
            ({"rx_extraction": None, "retries": {r.VISION_EXTRACT_RX: 2}}, r.TEMPLATES),
            ({"rx_extraction": None, "retries": {r.VISION_EXTRACT_RX: 5}}, r.TEMPLATES),
            # the final failure sets the "could not read" reply: it wins over a stored placeholder
            (
                {
                    "rx_extraction": EXTRACTION,
                    "template_key": "rx.needs_review",
                    "retries": {r.VISION_EXTRACT_RX: 2},
                },
                r.TEMPLATES,
            ),
        ],
    )
    def test_next_node(self, fields, expected):
        assert r.after_vision_extract(state(**fields)) == expected

    def test_a_walk_through_the_failures_ends_after_exactly_one_retry(self):
        visits, retries = 0, 0
        node = r.VISION_EXTRACT_RX
        while node == r.VISION_EXTRACT_RX:
            visits += 1
            retries += 1  # what the node writes into the state on every call
            node = r.after_vision_extract(
                state(rx_extraction=None, retries={r.VISION_EXTRACT_RX: retries})
            )
            assert visits < 10, "the retry loop does not end"
        assert (visits, node) == (2, r.TEMPLATES)


class TestTopology:
    def test_every_node_is_reachable_and_ends(self):
        graph = build_graph().get_graph()
        names = set(graph.nodes) - {"__start__", "__end__"}
        assert names == {
            r.EMERGENCY_GUARD, r.REDACT, r.EMERGENCY_CLASSIFIER, r.TRANSCRIBE, r.PREPARE_IMAGE,
            r.CLASSIFY, r.VISION_EXTRACT_RX, r.VALIDATE_RX, r.NORMALIZE_DRUGS, r.GENERIC_FINDER,
            r.CONFIDENCE_GATE, r.EXTRACT_QUERY, r.COMPOSER, r.VERIFIER, r.TEMPLATES, r.RX_FALLBACK,
        }  # fmt: skip
        reachable, frontier = {"__start__"}, ["__start__"]
        while frontier:
            current = frontier.pop()
            for edge in graph.edges:
                if edge.source == current and edge.target not in reachable:
                    reachable.add(edge.target)
                    frontier.append(edge.target)
        assert reachable == set(graph.nodes)

    def test_only_templates_the_fallback_and_the_verifier_can_end_the_graph(self):
        graph = build_graph().get_graph()
        assert {e.source for e in graph.edges if e.target == "__end__"} == {
            r.TEMPLATES, r.RX_FALLBACK, r.VERIFIER,
        }  # fmt: skip

    def test_nothing_reaches_the_composer_without_passing_the_catalog_or_the_gate(self):
        graph = build_graph().get_graph()
        into_composer = {e.source for e in graph.edges if e.target == r.COMPOSER}
        assert into_composer == {r.GENERIC_FINDER, r.CONFIDENCE_GATE}
