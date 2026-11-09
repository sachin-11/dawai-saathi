"""Conditional edges: pure functions from the state to the NAME of the next node (M9).

No I/O, no model, no global state: each one is unit-tested with a table of states (see
`tests/test_graph_routing.py`). The rules that matter for safety:

  * `route_input` is the ONLY way into the emergency nodes, and it sends them text only. An image
    (and so any text read from it) goes to `prepare_image`: words written on a document are history,
    not a message from the user (CLAUDE.md §2.2).
  * the extraction retry is bounded by the counter in the state: at most ONE retry.
  * any node that wants a static reply just sets `template_key`; every edge checks it first.
"""

from langgraph.graph import END

from app.graph.state import GraphState
from app.schemas.process import InputType, Intent

# node names
EMERGENCY_GUARD = "emergency_guard"
REDACT = "redact"
EMERGENCY_CLASSIFIER = "emergency_classifier"
TRANSCRIBE = "transcribe"
PREPARE_IMAGE = "prepare_image"
CLASSIFY = "classify"
VISION_EXTRACT_RX = "vision_extract_rx"
VALIDATE_RX = "validate_rx"
NORMALIZE_DRUGS = "normalize_drugs"
GENERIC_FINDER = "generic_finder"
CONFIDENCE_GATE = "confidence_gate"
EXTRACT_QUERY = "extract_query"
EXTRACT_INTERACTION_QUERY = "extract_interaction_query"
MATCH_QUERY_MEDICINES = "match_query_medicines"
INTERACTION_CHECK = "interaction_check"
COMPOSER = "composer"
VERIFIER = "verifier"
TEMPLATES = "templates"
RX_FALLBACK = "rx_fallback"
VISION_EXTRACT_LAB = "vision_extract_lab"
LAB_NORMALIZE = "lab_normalize"
LAB_COMPARE = "lab_compare"
LAB_GATE = "lab_gate"
LAB_QUESTION = "lab_question"

MAX_EXTRACTION_RETRIES = 1


def route_input(state: GraphState) -> str:
    """START: text -> emergency guard; image or PDF -> prepare_image; audio -> transcribe."""
    input_type = state.request.input.type
    if input_type is InputType.image:
        return PREPARE_IMAGE
    if input_type is InputType.audio:
        return TRANSCRIBE
    return EMERGENCY_GUARD


def _templated_or(state: GraphState, nxt: str) -> str:
    return TEMPLATES if state.template_key else nxt


def after_emergency_guard(state: GraphState) -> str:
    return _templated_or(state, REDACT)


def after_emergency_classifier(state: GraphState) -> str:
    return _templated_or(state, CLASSIFY)


def after_prepare_image(state: GraphState) -> str:
    return _templated_or(state, CLASSIFY)


def after_classify(state: GraphState) -> str:
    if state.template_key:
        return TEMPLATES
    if state.image_kind == "prescription":
        return VISION_EXTRACT_RX
    if state.image_kind == "lab_report":
        return VISION_EXTRACT_LAB
    if state.intent is Intent.lab_report:
        return LAB_QUESTION
    if state.intent is Intent.generic_query:
        return EXTRACT_QUERY
    if state.intent is Intent.interaction_query:
        return EXTRACT_INTERACTION_QUERY
    return TEMPLATES  # unreachable: classify sets a template key for everything else


def after_vision_extract(state: GraphState) -> str:
    if state.template_key:  # the final "could not read" reply
        return TEMPLATES
    if state.rx_extraction is not None:
        return VALIDATE_RX
    if state.retries.get(VISION_EXTRACT_RX, 0) <= MAX_EXTRACTION_RETRIES:
        return VISION_EXTRACT_RX  # the single retry (stricter prompt)
    return TEMPLATES


def after_vision_extract_lab(state: GraphState) -> str:
    if state.template_key:  # the final "could not read this report" reply
        return TEMPLATES
    if state.lab_extraction is not None:
        return LAB_NORMALIZE
    if state.retries.get(VISION_EXTRACT_LAB, 0) <= MAX_EXTRACTION_RETRIES:
        return VISION_EXTRACT_LAB  # the single retry (stricter prompt)
    return TEMPLATES


def after_lab_normalize(state: GraphState) -> str:
    return _templated_or(state, LAB_COMPARE)


def after_lab_compare(state: GraphState) -> str:
    return _templated_or(state, LAB_GATE)


def after_lab_gate(state: GraphState) -> str:
    return _templated_or(state, COMPOSER)


def after_lab_question(state: GraphState) -> str:
    return _templated_or(state, COMPOSER)


def after_extract_query(state: GraphState) -> str:
    return _templated_or(state, NORMALIZE_DRUGS)


def after_normalize_drugs(state: GraphState) -> str:
    return _templated_or(state, GENERIC_FINDER)


def after_generic_finder(state: GraphState) -> str:
    if state.template_key:
        return TEMPLATES
    return COMPOSER if state.intent is Intent.generic_query else INTERACTION_CHECK


def after_extract_interaction_query(state: GraphState) -> str:
    return _templated_or(state, MATCH_QUERY_MEDICINES)


def after_match_query_medicines(state: GraphState) -> str:
    return _templated_or(state, INTERACTION_CHECK)


def after_interaction_check(state: GraphState) -> str:
    """A question goes straight to the composer; a prescription still passes the confidence gate."""
    if state.template_key:
        return TEMPLATES
    return COMPOSER if state.intent is Intent.interaction_query else CONFIDENCE_GATE


def after_confidence_gate(state: GraphState) -> str:
    return _templated_or(state, COMPOSER)


def after_verifier(state: GraphState) -> str:
    if state.verification is not None and state.verification.ok:
        return END
    return RX_FALLBACK
