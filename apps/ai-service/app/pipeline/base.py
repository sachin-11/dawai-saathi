"""The `Pipeline` interface the `/v1/process` endpoint talks to.

M5 ships `MinimalPipeline`. M9 replaces it with the LangGraph pipeline behind the same interface, so
the endpoint, the contract and the gateway do not change.
"""

from dataclasses import dataclass, field
from typing import Protocol

from app.catalog.service import CatalogService
from app.config import Settings
from app.llm.router import Deadline, LLMRouter
from app.llm.types import LLMResult
from app.prompts.registry import PromptRegistry, TemplateStore
from app.safety.emergency_guard import EmergencyGuard
from app.safety.redaction import Redactor, get_redactor
from app.schemas.prescription import PrescriptionExtraction
from app.schemas.process import (
    EmergencyCategory,
    Intent,
    ProcessRequest,
    Reply,
    TraceEntry,
    Warning,
)


@dataclass(slots=True)
class RequestUsage:
    """What one request cost: summed over every LLM call it made."""

    cost_usd: float = 0.0
    latency_ms: int = 0
    model: str | None = None
    provider: str | None = None
    fallback_used: bool = False
    prompt_versions: list[str] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0

    def add(self, result: LLMResult, prompt_version: str | None) -> None:
        self.cost_usd += result.cost_usd
        self.input_tokens += result.input_tokens
        self.output_tokens += result.output_tokens
        self.latency_ms += result.latency_ms
        self.model = result.model
        self.provider = result.provider
        self.fallback_used = self.fallback_used or result.fallback_used
        if prompt_version is not None:
            self.add_prompt_version(prompt_version)

    def add_prompt_version(self, version: str) -> None:
        if version not in self.prompt_versions:
            self.prompt_versions.append(version)


@dataclass(frozen=True, slots=True)
class PipelineContext:
    settings: Settings
    router: LLMRouter
    prompts: PromptRegistry
    templates: TemplateStore
    deadline: Deadline
    usage: RequestUsage
    guard: EmergencyGuard = field(default_factory=EmergencyGuard)
    redactor: Redactor = field(default_factory=get_redactor)
    # M8: None in tests that do not need the catalog; then no match / generic step runs.
    catalog: CatalogService | None = None


@dataclass(frozen=True, slots=True)
class PipelineOutput:
    intent: Intent
    emergency: bool
    reply: Reply
    warnings: list[Warning] = field(default_factory=list)
    emergency_category: EmergencyCategory | None = None
    extraction: PrescriptionExtraction | None = None
    # Per-node timings (no text, no values). Set by the graph; returned only to the demo client.
    debug_trace: list[TraceEntry] | None = None


class Pipeline(Protocol):
    async def run(self, request: ProcessRequest, ctx: PipelineContext) -> PipelineOutput: ...
