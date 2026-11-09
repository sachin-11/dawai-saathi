"""M15: Prometheus metrics, PHI-safe OpenTelemetry, trace propagation, cost guard states."""

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from app.observability.metrics import ALLOWED_LABELS, METRICS, REGISTRY
from app.observability.otel import (
    ScrubbingExporter,
    TailSamplingProcessor,
    ratio_keeps,
    scrub_attributes,
)
from tests.conftest import SERVICE_TOKEN, make_settings
from tests.test_process_endpoint import HEADERS, URL, app_with, client_for, payload

# ------------------------------------------------------------------ one provider for the module

_EXPORTER = InMemorySpanExporter()
_PROVIDER = TracerProvider()
_PROVIDER.add_span_processor(SimpleSpanProcessor(_EXPORTER))
trace.set_tracer_provider(_PROVIDER)  # first one wins: the only provider this test run installs


@pytest.fixture(autouse=True)
def _clear_spans() -> None:
    _EXPORTER.clear()


# ------------------------------------------------------------------ metrics


class TestMetrics:
    def test_every_collector_label_is_on_the_allowlist(self) -> None:
        used: set[str] = set()
        for family in REGISTRY.collect():
            for sample in family.samples:
                used.update(sample.labels)
        assert used <= ALLOWED_LABELS, used - ALLOWED_LABELS

    def test_label_names_declared_by_collectors_are_allowed(self) -> None:
        for collector in list(REGISTRY._collector_to_names):
            labels = getattr(collector, "_labelnames", ())
            assert set(labels) <= ALLOWED_LABELS, (collector, labels)

    async def test_metrics_endpoint_serves_the_registry(self) -> None:
        METRICS.observe_node("classify", 120)
        app, _ = app_with()
        async with client_for(app) as client:
            res = await client.get("/metrics")
        assert res.status_code == 200
        assert "graph_node_latency_ms_bucket" in res.text
        assert "llm_calls_total" in res.text or "graph_node_errors_total" in res.text

    async def test_metrics_need_the_token_when_one_is_set(self) -> None:
        app, _ = app_with(METRICS_TOKEN="metrics-token-123456")
        async with client_for(app) as client:
            assert (await client.get("/metrics")).status_code == 401
            bad = await client.get("/metrics", headers={"Authorization": "Bearer nope"})
            ok = await client.get(
                "/metrics", headers={"Authorization": "Bearer metrics-token-123456"}
            )
        assert bad.status_code == 401
        assert ok.status_code == 200

    async def test_llm_calls_are_counted_per_provider_model_and_role(self) -> None:
        app, _ = app_with()
        async with client_for(app) as client:
            await client.post(URL, json=payload(), headers=HEADERS)
            text = (await client.get("/metrics")).text
        assert "llm_calls_total{" in text
        assert "llm_latency_ms_bucket" in text


# ------------------------------------------------------------------ PHI-safe attributes


class TestScrubbing:
    def test_unknown_keys_and_phi_like_values_are_dropped(self) -> None:
        kept = scrub_attributes(
            {
                "http.method": "POST",
                "http.url": "https://s3/x?X-Amz-Signature=abc",
                "db.statement": "SELECT * FROM users WHERE phone='9876543210'",
                "dawai.request_id": "wamid.abc",
                "dawai.note": "call me on +91 98765 43210",
                "dawai.phone": "9876543210",
                "dawai.trace": "0123456789abcdef0123456789abcdef",
                "dawai.mail": "someone@example.com",
                "dawai.user_text": "x" * 500,
                "patient.name": "Ramesh Kumar",
                "dawai.cost_usd": 0.012,
            }
        )
        assert kept == {
            "http.method": "POST",
            "dawai.request_id": "wamid.abc",
            "dawai.trace": "0123456789abcdef0123456789abcdef",
            "dawai.cost_usd": 0.012,
        }

    def test_exported_spans_lose_events_status_text_and_unknown_attributes(self) -> None:
        inner = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(ScrubbingExporter(inner)))
        tracer = provider.get_tracer("t")
        with tracer.start_as_current_span("op") as span:
            span.set_attribute("dawai.node", "classify")
            span.set_attribute("user.phone", "9876543210")
            span.record_exception(ValueError("Ramesh Kumar 9876543210"))
            span.set_status(StatusCode.ERROR, "failed for Ramesh Kumar")
        [done] = inner.get_finished_spans()
        assert dict(done.attributes or {}) == {"dawai.node": "classify"}
        assert not done.events
        assert done.status.status_code is StatusCode.ERROR
        assert done.status.description is None


# ------------------------------------------------------------------ tail sampling


class TestTailSampling:
    def _run(self, ratio: float, *, error: bool = False, emergency: bool = False) -> int:
        sink = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(TailSamplingProcessor(SimpleSpanProcessor(sink), ratio))
        tracer = provider.get_tracer("t")
        with (
            tracer.start_as_current_span("root") as root,
            tracer.start_as_current_span("child") as child,
        ):
            if error:
                child.set_status(StatusCode.ERROR)
            if emergency:
                root.set_attribute("dawai.emergency", True)
        return len(sink.get_finished_spans())

    def test_ratio_zero_drops_ordinary_traces(self) -> None:
        assert self._run(0.0) == 0

    def test_ratio_one_keeps_everything(self) -> None:
        assert self._run(1.0) == 2

    def test_errors_are_always_kept(self) -> None:
        assert self._run(0.0, error=True) == 2

    def test_emergencies_are_always_kept(self) -> None:
        assert self._run(0.0, emergency=True) == 2

    def test_the_ratio_decision_depends_only_on_the_trace_id(self) -> None:
        import random

        rng = random.Random(7)  # noqa: S311
        ids = [rng.getrandbits(128) for _ in range(2000)]
        kept = sum(ratio_keeps(i, 0.2) for i in ids)
        assert 250 < kept < 550
        assert ratio_keeps(ids[7], 0.2) == ratio_keeps(ids[7], 0.2)


# ------------------------------------------------------------------ propagation


class TestPropagation:
    async def test_node_spans_continue_the_trace_sent_by_the_gateway(self) -> None:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        app, _ = app_with()
        FastAPIInstrumentor.instrument_app(app)
        try:
            tracer = trace.get_tracer("gateway-test")
            carrier: dict[str, str] = {}
            with tracer.start_as_current_span("worker") as parent:
                TraceContextTextMapPropagator().inject(carrier)
                gateway_trace_id = parent.get_span_context().trace_id
            async with client_for(app) as client:
                res = await client.post(URL, json=payload(), headers={**HEADERS, **carrier})
            assert res.status_code == 200
        finally:
            FastAPIInstrumentor.uninstrument_app(app)
        spans = _EXPORTER.get_finished_spans()
        node_spans = [s for s in spans if s.name.startswith("graph.")]
        assert node_spans, [s.name for s in spans]
        assert {s.context.trace_id for s in node_spans} == {gateway_trace_id}
        server = [s for s in spans if (s.attributes or {}).get("dawai.request_id")]
        assert server and server[0].context.trace_id == gateway_trace_id

    async def test_the_langfuse_trace_id_is_linked_on_the_span(self) -> None:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        from app.llm.factory import build_llm_router
        from app.main import create_app
        from app.observability.tracing import LangfuseTracer, observe_llm_call
        from tests.test_tracing import FakeLangfuse

        config = make_settings()
        router = build_llm_router(config, observer=observe_llm_call)
        app = create_app(config, llm_router=router, tracer=LangfuseTracer(FakeLangfuse()))
        FastAPIInstrumentor.instrument_app(app)
        try:
            async with client_for(app) as client:
                body = (await client.post(URL, json=payload(), headers=HEADERS)).json()
        finally:
            FastAPIInstrumentor.uninstrument_app(app)
        linked = [
            s
            for s in _EXPORTER.get_finished_spans()
            if (s.attributes or {}).get("dawai.langfuse_trace_id")
        ]
        assert linked
        assert linked[0].attributes["dawai.langfuse_trace_id"] == body["meta"]["trace_id"]


# ------------------------------------------------------------------ cost guard


EMERGENCY_TEXT = "mujhe seene me bahut dard ho raha hai"
AUDIO = {"type": "audio", "media_url": "http://localhost:9000/x.ogg", "mime": "audio/ogg"}


def with_state(state: str, **overrides: object) -> dict[str, object]:
    return payload(options={"budget_state": state}, **overrides)


class TestBudgetStates:
    async def test_normal_answers_a_text_question(self) -> None:
        app, _ = app_with()
        async with client_for(app) as client:
            res = await client.post(URL, json=with_state("normal"), headers=HEADERS)
        assert res.json()["intent"] == "help"

    @pytest.mark.parametrize("state", ["essential", "exhausted"])
    async def test_restricted_states_give_the_busy_template_for_text(self, state: str) -> None:
        app, _ = app_with()
        async with client_for(app) as client:
            res = await client.post(URL, json=with_state(state), headers=HEADERS)
        body = res.json()
        assert "112" in body["reply"]["text"]
        assert body["meta"]["cost_usd"] == 0.0
        assert body["emergency"] is False

    @pytest.mark.parametrize("state", ["economy", "essential", "exhausted"])
    @pytest.mark.parametrize("text", [EMERGENCY_TEXT, "chest pain and I cannot breathe"])
    async def test_an_emergency_is_answered_in_every_state(self, state: str, text: str) -> None:
        app, _ = app_with()
        async with client_for(app) as client:
            res = await client.post(
                URL,
                json=with_state(state, input={"type": "text", "text": text}),
                headers=HEADERS,
            )
        body = res.json()
        assert body["emergency"] is True
        assert "112" in body["reply"]["text"]

    @pytest.mark.parametrize("state", ["essential", "exhausted"])
    async def test_voice_notes_wait_and_the_reply_names_112(self, state: str) -> None:
        app, _ = app_with()
        async with client_for(app) as client:
            res = await client.post(URL, json=with_state(state, input=AUDIO), headers=HEADERS)
        assert res.status_code == 200
        text = res.json()["reply"]["text"]
        assert "112" in text

    async def test_economy_uses_the_cheap_model_for_text_roles(self) -> None:
        from app.llm.budget_router import EconomyRouter

        calls: list[str] = []

        class Inner:
            async def generate(self, role: str, *_a: object, **_k: object) -> object:
                calls.append(role)
                return object()

        router = EconomyRouter(Inner())  # type: ignore[arg-type]
        await router.generate("text", [], name="x")
        await router.generate("vision", [], name="x")
        await router.generate("cheap", [], name="x")
        assert calls == ["cheap", "vision", "cheap"]

    async def test_unknown_budget_state_is_rejected_by_the_contract(self) -> None:
        app, _ = app_with()
        async with client_for(app) as client:
            res = await client.post(URL, json=with_state("bogus"), headers=HEADERS)
        assert res.status_code == 422

    async def test_the_budget_state_gauge_follows_the_request(self) -> None:
        app, _ = app_with()
        async with client_for(app) as client:
            await client.post(URL, json=with_state("essential"), headers=HEADERS)
            text = (await client.get("/metrics")).text
        assert "budget_state 2.0" in text


class TestPerRequestCap:
    async def test_a_tiny_cap_stops_the_vision_step_with_a_polite_reply(self) -> None:
        from app.graph.traced import _over_cost_cap
        from app.pipeline.base import PipelineContext

        settings = make_settings(MAX_COST_PER_REQUEST_USD="0.01", COST_ESTIMATE_VISION_USD="0.03")
        ctx = PipelineContext.__new__(PipelineContext)
        object.__setattr__(ctx, "settings", settings)
        assert _over_cost_cap("vision_extract_rx", "vision", 0.0, ctx) is True
        assert _over_cost_cap("classify", "cheap", 0.005, ctx) is False
        assert _over_cost_cap("classify", "cheap", 0.02, ctx) is True

    async def test_safety_nodes_are_never_capped(self) -> None:
        from app.graph.traced import _over_cost_cap
        from app.pipeline.base import PipelineContext

        settings = make_settings(MAX_COST_PER_REQUEST_USD="0.01")
        ctx = PipelineContext.__new__(PipelineContext)
        object.__setattr__(ctx, "settings", settings)
        for node in ("emergency_guard", "emergency_classifier", "templates", "verifier"):
            assert _over_cost_cap(node, "cheap", 5.0, ctx) is False

    async def test_no_cap_means_no_limit(self) -> None:
        from app.graph.traced import _over_cost_cap
        from app.pipeline.base import PipelineContext

        ctx = PipelineContext.__new__(PipelineContext)
        object.__setattr__(ctx, "settings", make_settings())
        assert _over_cost_cap("vision_extract_rx", "vision", 99.0, ctx) is False


class TestStartupProbe:
    async def test_startup_is_503_until_the_models_are_loaded(self) -> None:
        app, _ = app_with()
        async with client_for(app) as client:
            before = await client.get("/health/startup")
            app.state.started = True
            after = await client.get("/health/startup")
        assert before.status_code == 503
        assert after.status_code == 200


def test_service_token_constant_is_in_use() -> None:
    assert SERVICE_TOKEN
