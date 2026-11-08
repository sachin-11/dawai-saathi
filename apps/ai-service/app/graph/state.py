"""The typed state every graph node reads and updates (M9, CLAUDE.md §8.2).

Rules:
  * a node returns ONLY the keys it changes (a partial update); it never mutates `state`
  * `warnings`, `errors`, `node_timings` append, `cost_usd` sums, `retries` merges (reducers below)
  * `images` (the user's file, in memory) is EXCLUDED from serialisation: it can never end up in a
    trace, a log or a checkpoint. There is no checkpointer at all: the service is stateless per
    request (CLAUDE.md §4: the gateway owns all user state), and each request starts from scratch.
  * request-wide, non-data objects (settings, router, prompts, catalog, deadline) are NOT state: they
    travel as the graph's runtime context (`PipelineContext`)
"""

import operator
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.llm.types import ImageInput
from app.safety.emergency_guard import EmergencyResult
from app.schemas.catalog import DrugMatch, GenericSuggestion
from app.schemas.prescription import PrescriptionExtraction
from app.schemas.process import Intent, ProcessRequest, Reply, Warning
from app.tools.generic_render import DetailItem

ImageKind = Literal["prescription", "lab_report", "medicine_strip", "other"]
NodeStatus = Literal["ok", "error", "timeout", "fallback"]


class NodeTiming(BaseModel):
    """What one node did. Numbers and ids only: no text, no extracted value."""

    node: str
    latency_ms: int
    status: NodeStatus
    model: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    prompt_version: str | None = None


class NodeError(BaseModel):
    node: str
    code: str  # a short machine token such as "schema_invalid" or "timeout"


class VerificationResult(BaseModel):
    ok: bool
    failures: list[str] = Field(default_factory=list)  # codes only, never text


def _merge(left: dict[str, int], right: dict[str, int]) -> dict[str, int]:
    return {**left, **right}


class GraphState(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    request: ProcessRequest

    # ---- input
    raw_text: str | None = None  # the user's own words, only ever read by the emergency rules
    redacted_text: str | None = None  # the only text a model, a log or a trace may see
    images: list[ImageInput] = Field(default_factory=list, exclude=True)

    # ---- routing
    emergency: EmergencyResult | None = None
    image_kind: ImageKind | None = None
    intent: Intent | None = None
    template_key: str | None = None  # a node sets it when the reply is a static template
    query_name: str | None = None  # typed generic query: the medicine as written
    query_strength: str | None = None

    # ---- domain
    rx_extraction: PrescriptionExtraction | None = None
    gate_failure: str | None = None
    drug_matches: list[DrugMatch | None] = Field(default_factory=list)  # aligned with medicines
    generics: list[GenericSuggestion | None] = Field(default_factory=list)  # aligned with medicines
    generic_items: list[DetailItem] = Field(
        default_factory=list
    )  # typed query: what the reply lists
    warnings: Annotated[list[Warning], operator.add] = Field(default_factory=list)
    llm_lines: dict[int, str] | None = (
        None  # the composer's candidate lines, checked by the verifier
    )
    compose_problems: list[str] = Field(default_factory=list)

    # ---- output
    reply: Reply | None = None
    reply_source: Literal["llm", "template"] | None = None
    verification: VerificationResult | None = None

    # ---- bookkeeping
    retries: Annotated[dict[str, int], _merge] = Field(default_factory=dict)
    errors: Annotated[list[NodeError], operator.add] = Field(default_factory=list)
    node_timings: Annotated[list[NodeTiming], operator.add] = Field(default_factory=list)
    cost_usd: Annotated[float, operator.add] = 0.0
