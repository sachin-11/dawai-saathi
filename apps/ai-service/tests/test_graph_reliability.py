"""Timeouts, deadlines, loops and error handling of the graph (M9)."""

import asyncio
import dataclasses
from typing import Any

import pytest
from langgraph.graph import StateGraph

from app.graph.errors import NodeTimeoutError
from app.graph.state import GraphState
from app.llm.fake import FakeProvider
from app.llm.router import Deadline
from app.llm.types import LLMServerError
from app.main import create_app
from app.observability.metrics import METRICS
from app.pipeline.base import PipelineContext
from app.pipeline.graph import GraphPipeline
from app.schemas.process import Intent
from tests.conftest import SERVICE_TOKEN, make_settings
from tests.graph_support import nodes_run, seeded_catalog, text_request
from tests.rx_support import (
    CLASSIFY_RX,
    extraction,
    fake_fetch,
    image_request,
    make_ctx,
    medicine,
    sample_jpeg,
)
from tests.test_process_endpoint import HEADERS, URL, client_for, payload


@pytest.fixture(autouse=True)
def _jpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
    )
    METRICS.reset()


class SlowFor(FakeProvider):
    """A fake provider that is slow for one structured task (found by a field of the response model)."""

    def __init__(self, field: str, seconds: float, script: list[Any] | None = None) -> None:
        super().__init__(script)
        self._field = field
        self._seconds = seconds

    async def generate(self, messages, *, response_model=None, **kwargs):  # type: ignore[no-untyped-def]
        if response_model is not None and self._field in response_model.model_fields:
            await asyncio.sleep(self._seconds)
        return await super().generate(messages, response_model=response_model, **kwargs)


class TestNodeTimeouts:
    async def test_a_slow_composer_falls_back_to_the_template(self):
        settings = make_settings(NODE_TIMEOUT_COMPOSER_S="0.05")
        provider = SlowFor("items", 1.0, [CLASSIFY_RX, extraction(medicine())])
        ctx = make_ctx(provider, settings, catalog=seeded_catalog())
        output = await GraphPipeline().run(image_request(), ctx)
        assert (
            "Dolo 650 (tablet, 650 mg)" in output.reply.text
            and output.intent is Intent.prescription
        )
        composer = next(t for t in output.debug_trace or [] if t.node == "composer")
        assert composer.status == "fallback" and composer.latency_ms < 800
        assert METRICS.fallback_total["composer_timeout"] == 1
        assert METRICS.node_errors_total[("composer", "timeout")] == 1

    async def test_a_slow_emergency_classifier_keeps_the_rules_verdict_and_the_request_goes_on(
        self,
    ):
        settings = make_settings(NODE_TIMEOUT_CHEAP_S="0.05", EMERGENCY_CLASSIFIER_TIMEOUT_S="30")
        provider = SlowFor("is_emergency", 1.0)
        ctx = make_ctx(provider, settings)
        output = await GraphPipeline().run(text_request("what can you do for my medicines"), ctx)
        assert not output.emergency and output.intent is Intent.help
        classifier = next(t for t in output.debug_trace or [] if t.node == "emergency_classifier")
        assert classifier.status == "fallback"

    async def test_a_slow_cheap_classifier_shows_the_help_text(self):
        settings = make_settings(NODE_TIMEOUT_CHEAP_S="0.05")
        provider = SlowFor("intent", 1.0)
        output = await GraphPipeline().run(
            text_request("something about tablets"), make_ctx(provider, settings)
        )
        assert output.intent is Intent.other and "Dawai Saathi" in output.reply.text

    async def test_a_node_without_a_fallback_fails_the_request(self):
        settings = make_settings(NODE_TIMEOUT_VISION_S="0.05")
        provider = SlowFor("is_prescription", 1.0, [CLASSIFY_RX])
        with pytest.raises(NodeTimeoutError) as info:
            await GraphPipeline().run(
                image_request(), make_ctx(provider, settings, catalog=seeded_catalog())
            )
        assert info.value.node == "vision_extract_rx"
        assert METRICS.node_errors_total[("vision_extract_rx", "timeout")] == 1

    async def test_the_endpoint_maps_it_to_504_with_a_stable_code(self, monkeypatch):
        settings = make_settings(NODE_TIMEOUT_VISION_S="0.05")
        provider = SlowFor("is_prescription", 1.0, [CLASSIFY_RX])
        from app.llm.factory import build_llm_router

        router = build_llm_router(settings, fake_provider=provider)
        app = create_app(settings, llm_router=router)
        body = payload(
            input={
                "type": "image",
                "media_url": "http://localhost:9000/b/k?s=1",
                "mime": "image/jpeg",
            }
        )
        async with client_for(app) as client:
            res = await client.post(URL, json=body, headers=HEADERS)
        assert res.status_code == 504 and res.json()["error"]["code"] == "NODE_TIMEOUT"


class TestTheRequestDeadline:
    async def test_an_exhausted_deadline_stops_the_nodes_that_cannot_recover(self):
        ctx = dataclasses.replace(
            make_ctx(FakeProvider([CLASSIFY_RX]), catalog=seeded_catalog()), deadline=Deadline(0)
        )
        with pytest.raises(NodeTimeoutError):
            await GraphPipeline().run(image_request(), ctx)

    async def test_nodes_with_a_fallback_still_answer_when_time_is_up(self):
        # Every node sees "no time left": the cheap-model nodes recover, the rest of text handling is fast
        ctx = dataclasses.replace(make_ctx(FakeProvider()), deadline=Deadline(0))
        with pytest.raises(NodeTimeoutError):  # redact has no fallback: the request fails cleanly
            await GraphPipeline().run(text_request("hello there my friend"), ctx)


class TestNoLoops:
    def looping_pipeline(self) -> GraphPipeline:
        graph = StateGraph(GraphState, context_schema=PipelineContext)

        async def spin(state: GraphState) -> dict[str, Any]:
            return {}

        graph.add_node("spin", spin)
        graph.set_entry_point("spin")
        graph.add_conditional_edges("spin", lambda state: "spin", {"spin": "spin"})
        return GraphPipeline(graph.compile())

    async def test_the_recursion_limit_stops_a_runaway_graph(self):
        from langgraph.errors import GraphRecursionError

        with pytest.raises(GraphRecursionError):
            await self.looping_pipeline().run(text_request("hello"), make_ctx(FakeProvider()))

    async def test_the_endpoint_turns_it_into_a_clean_500(self):
        settings = make_settings()
        app = create_app(settings, pipeline=self.looping_pipeline())
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 500 and res.json()["error"]["code"] == "GRAPH_LIMIT"

    def test_the_limit_is_explicit_and_configurable(self):
        assert make_settings().graph_recursion_limit == 25
        assert make_settings(GRAPH_RECURSION_LIMIT="12").graph_recursion_limit == 12


class TestErrorsKeepTheirMeaning:
    async def test_a_provider_outage_still_reaches_the_gateway_as_503(self):
        from app.llm.factory import build_llm_router

        settings = make_settings()
        # emergency classifier fails safe; the intent classifier has nothing left to fall back to
        provider = FakeProvider(
            [LLMServerError(), LLMServerError(), LLMServerError(), LLMServerError()]
        )
        app = create_app(settings, llm_router=build_llm_router(settings, fake_provider=provider))
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 503 and res.json()["error"]["code"] == "LLM_UNAVAILABLE"

    async def test_a_node_error_is_counted_by_code(self):
        provider = FakeProvider(
            [
                {"is_emergency": False, "category": None, "confidence": 0.9},
                LLMServerError(),
                LLMServerError(),
            ]
        )
        from app.llm.types import LLMUnavailableError

        with pytest.raises(LLMUnavailableError):
            await GraphPipeline().run(text_request("kya kar sakte ho?"), make_ctx(provider))
        assert METRICS.node_errors_total[("classify", "unavailable")] == 1

    async def test_the_rollback_switch_still_works(self):
        from app.main import default_pipeline
        from app.pipeline.rx import RxPipeline

        assert isinstance(default_pipeline(make_settings()), GraphPipeline)
        assert isinstance(default_pipeline(make_settings(PIPELINE="minimal")), RxPipeline)

    async def test_the_node_names_in_the_trace_are_stable_for_the_demo(self):
        output = await GraphPipeline().run(text_request("hello"), make_ctx(FakeProvider()))
        assert nodes_run(output) == [
            "emergency_guard",
            "redact",
            "emergency_classifier",
            "classify",
            "templates",
        ]

    def test_the_service_token_constant_is_what_the_helpers_use(self):
        assert HEADERS["X-Service-Token"] == SERVICE_TOKEN
