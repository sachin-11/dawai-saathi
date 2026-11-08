"""Helpers for the LangGraph tests (M9)."""

from typing import Any

from langgraph.runtime import Runtime

from app.catalog.service import CatalogService
from app.graph.state import GraphState
from app.llm.fake import FakeProvider
from app.pipeline.base import PipelineContext, PipelineOutput
from app.pipeline.graph import GraphPipeline
from app.schemas.process import ProcessRequest
from tests.catalog_support import repo_of, seed_rows
from tests.rx_support import make_ctx

NOT_EMERGENCY: dict[str, Any] = {"is_emergency": False, "category": None, "confidence": 0.9}


def seeded_catalog() -> CatalogService:
    """The real curated brands + the fictional-price fixture, in memory."""
    return CatalogService(repo_of(seed_rows()))


def text_request(text: str, language: str = "en") -> ProcessRequest:
    return ProcessRequest.model_validate(
        {
            "request_id": "wamid.graph-1",
            "user": {"language": language, "age": None, "sex": None},
            "input": {"type": "text", "text": text},
        }
    )


def audio_request(language: str = "en") -> ProcessRequest:
    return ProcessRequest.model_validate(
        {
            "request_id": "wamid.graph-audio",
            "user": {"language": language, "age": None, "sex": None},
            "input": {
                "type": "audio",
                "media_url": "http://localhost:9000/b/k?s=1",
                "mime": "audio/ogg",
            },
        }
    )


def runtime_for(ctx: PipelineContext) -> Runtime[PipelineContext]:
    return Runtime(context=ctx)


def state_for(request: ProcessRequest, **fields: Any) -> GraphState:
    return GraphState(request=request, **fields)


async def run_graph(
    provider: FakeProvider, request: ProcessRequest, catalog: CatalogService | None = None
) -> tuple[PipelineOutput, PipelineContext]:
    ctx = make_ctx(provider, catalog=catalog)
    output = await GraphPipeline().run(request, ctx)
    return output, ctx


def nodes_run(output: PipelineOutput) -> list[str]:
    assert output.debug_trace is not None
    return [entry.node for entry in output.debug_trace]
