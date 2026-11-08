"""Traces, logs, metrics and the demo's `debug_trace` (M9): one span per node, no PHI, gated output."""

import json
from typing import Any

import pytest
from structlog.testing import capture_logs

from app.llm.factory import build_llm_router
from app.llm.fake import FakeProvider
from app.main import create_app
from app.observability.logging import configure_logging
from app.observability.metrics import METRICS
from app.observability.tracing import LangfuseTracer, observe_llm_call
from app.pipeline.graph import GraphPipeline
from tests.conftest import make_settings
from tests.graph_support import NOT_EMERGENCY, seeded_catalog, text_request
from tests.rx_support import (
    CLASSIFY_RX,
    extraction,
    f,
    fake_fetch,
    image_request,
    make_ctx,
    medicine,
    sample_jpeg,
)
from tests.test_process_endpoint import HEADERS, URL, client_for, payload
from tests.test_tracing import FakeLangfuse, FakeObservation

DEMO = "demo-token-0123456789"
DEMO_HEADERS = {"X-Service-Token": DEMO}


class IdObservation(FakeObservation):
    def __init__(self, kwargs: dict[str, Any], ident: str) -> None:
        super().__init__(kwargs)
        self.id = ident


class IdLangfuse(FakeLangfuse):
    """Like the fake client, but every observation has an id so nesting can be checked."""

    def start_observation(self, **kwargs: Any) -> IdObservation:
        observation = IdObservation(kwargs, f"obs-{len(self.observations) + 1}")
        self.observations.append(observation)
        return observation

    def by_name(self, name: str) -> IdObservation:
        return next(o for o in self.observations if o.kwargs["name"] == name)  # type: ignore[return-value]


@pytest.fixture(autouse=True)
def _jpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
    )
    METRICS.reset()


def traced_app(provider: FakeProvider | None = None, **settings: Any):
    langfuse = IdLangfuse()
    config = make_settings(DEMO_SERVICE_TOKEN=DEMO, **settings)
    router = build_llm_router(
        config, observer=observe_llm_call, fake_provider=provider, pricing=None
    )
    app = create_app(
        config, llm_router=router, tracer=LangfuseTracer(langfuse), catalog=seeded_catalog()
    )
    return app, langfuse


IMAGE_BODY = {"type": "image", "media_url": "http://localhost:9000/b/k?s=1", "mime": "image/jpeg"}


class TestSpansPerNode:
    async def test_one_span_per_node_under_the_root_and_generations_nest_under_their_node(self):
        app, langfuse = traced_app()
        async with client_for(app) as client:
            body = payload(input={"type": "text", "text": "kya kar sakte ho?"})
            res = await client.post(URL, json=body, headers=HEADERS)
        assert res.status_code == 200
        root = langfuse.by_name("process")
        nodes = ["emergency_guard", "redact", "emergency_classifier", "classify", "templates"]
        for name in nodes:
            span = langfuse.by_name(name)
            assert span.kwargs["trace_context"]["parent_span_id"] == root.id, name
            assert span.ended and span.updates[0]["status_message"] == "ok", name
        assert (
            langfuse.by_name("classify_intent").kwargs["trace_context"]["parent_span_id"]
            == langfuse.by_name("classify").id
        )
        assert (
            langfuse.by_name("emergency_classify").kwargs["trace_context"]["parent_span_id"]
            == langfuse.by_name("emergency_classifier").id
        )

    async def test_a_failing_node_ends_its_span_as_an_error(self):
        from app.llm.types import LLMServerError

        provider = FakeProvider([NOT_EMERGENCY, LLMServerError(), LLMServerError()])
        app, langfuse = traced_app(provider)
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 503
        span = langfuse.by_name("classify")
        assert (
            span.ended
            and span.updates[0]["level"] == "ERROR"
            and span.updates[0]["status_message"] == "error"
        )
        assert langfuse.by_name("process").ended

    async def test_a_prescription_has_spans_for_the_whole_chain(self):
        provider = FakeProvider(
            [
                CLASSIFY_RX,
                extraction(medicine()),
                {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet"}]},
            ]
        )
        app, langfuse = traced_app(provider)
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(input=IMAGE_BODY), headers=HEADERS)
        assert res.status_code == 200
        names = [
            o.kwargs["name"] for o in langfuse.observations if o.kwargs.get("as_type") == "span"
        ]
        assert names == [
            "process", "prepare_image", "classify", "vision_extract_rx", "validate_rx",
            "normalize_drugs", "generic_finder", "interaction_check", "confidence_gate", "composer", "verifier",
        ]  # fmt: skip
        assert (
            langfuse.by_name("vision_extract_rx").kwargs["trace_context"]["parent_span_id"]
            == langfuse.by_name("process").id
        )


class TestNoPhiInTraces:
    async def test_a_typed_message_is_traced_redacted(self):
        app, langfuse = traced_app()
        text = "my number is 9876543210 and aadhaar 2345 6789 0124, what can you do"
        async with client_for(app) as client:
            await client.post(
                URL, json=payload(input={"type": "text", "text": text}), headers=HEADERS
            )
        sent = langfuse.everything_sent()
        assert "9876543210" not in sent and "2345 6789 0124" not in sent and "[PHONE]" in sent

    async def test_text_read_from_a_prescription_and_the_image_never_reach_a_trace(self):
        secret = medicine(raw_text=f("Tab. SECRET-OCR-LINE 1-0-1 ph 9876543210"))
        provider = FakeProvider(
            [
                CLASSIFY_RX,
                extraction(secret),
                {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet"}]},
            ]
        )
        app, langfuse = traced_app(provider)
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(input=IMAGE_BODY), headers=HEADERS)
        assert res.status_code == 200
        sent = langfuse.everything_sent()
        assert "SECRET-OCR-LINE" not in sent and "9876543210" not in sent
        assert "[image: image/jpeg" in sent  # a placeholder: the picture itself is never sent
        assert "omitted" in sent  # the vision output is replaced by a note

    async def test_a_repaired_vision_answer_does_not_leak_through_the_repair_prompt(self):
        broken = {"raw_text": {"value": "SECRET-OCR-LINE"}, "nonsense": 1}
        provider = FakeProvider(
            [
                CLASSIFY_RX,
                broken,
                extraction(medicine()),
                {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet"}]},
            ]
        )
        app, langfuse = traced_app(provider)
        async with client_for(app) as client:
            await client.post(URL, json=payload(input=IMAGE_BODY), headers=HEADERS)
        assert "SECRET-OCR-LINE" not in langfuse.everything_sent()

    async def test_span_payloads_hold_numbers_and_names_only(self):
        app, langfuse = traced_app()
        async with client_for(app) as client:
            await client.post(
                URL,
                json=payload(input={"type": "text", "text": "hello there friend"}),
                headers=HEADERS,
            )
        for observation in langfuse.observations:
            if observation.kwargs["name"] in {"emergency_guard", "redact", "classify", "templates"}:
                for update in observation.updates:
                    assert set(update["output"]) == {"latency_ms", "tokens_in", "tokens_out"}


class TestLogsAndMetrics:
    async def test_one_structured_line_per_node_with_no_content(self):
        configure_logging("info")  # other tests silence the global logger; capture needs it on
        secret = "SECRET-WORD-9876543210"
        ctx = make_ctx(FakeProvider())
        with capture_logs() as logs:
            await GraphPipeline().run(text_request(f"hello {secret}"), ctx)
        node_lines = [entry for entry in logs if entry["event"] == "graph_node"]
        assert [e["node"] for e in node_lines] == [
            "emergency_guard",
            "redact",
            "emergency_classifier",
            "classify",
            "templates",
        ]
        for entry in node_lines:
            assert set(entry) == {"event", "node", "latency_ms", "status", "log_level"}
        assert secret not in json.dumps(logs, default=str)

    async def test_metrics_count_latency_per_node(self):
        await GraphPipeline().run(text_request("hello"), make_ctx(FakeProvider()))
        assert set(METRICS.node_latency_ms) == {
            "emergency_guard",
            "redact",
            "emergency_classifier",
            "classify",
            "templates",
        }
        assert all(h.count == 1 and sum(h.buckets) == 1 for h in METRICS.node_latency_ms.values())

    async def test_a_verifier_fallback_is_counted(self):
        lie = {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet, also take Crocin"}]}
        provider = FakeProvider([CLASSIFY_RX, extraction(medicine()), lie])
        await GraphPipeline().run(image_request(), make_ctx(provider, catalog=seeded_catalog()))
        assert METRICS.fallback_total["verifier_failed"] == 1

    async def test_node_timings_carry_tokens_cost_model_and_prompt_version(self):
        provider = FakeProvider(
            [
                CLASSIFY_RX,
                extraction(medicine()),
                {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet"}]},
            ]
        )
        output = await GraphPipeline().run(
            image_request(), make_ctx(provider, catalog=seeded_catalog())
        )
        by_node = {t.node: t for t in output.debug_trace or []}
        assert (
            by_node["vision_extract_rx"].tokens_in
            and by_node["vision_extract_rx"].prompt_version == "rx_extract_v1"
        )
        assert (
            by_node["classify"].prompt_version == "image_classify_v1"
            and by_node["classify"].model == "fake-model"
        )
        assert by_node["composer"].prompt_version == "rx_compose_v1,rx_reply_v1"
        assert by_node["validate_rx"].tokens_in is None and by_node["validate_rx"].model is None


class TestDebugTraceIsForTheDemoOnly:
    def body(self, include: bool, **input_override: Any) -> dict[str, Any]:
        body = payload(input={"type": "text", "text": "hello there friend"})
        body["options"] = {"include_trace": include}
        return body

    async def test_the_demo_client_gets_it_when_it_asks(self):
        app, _ = traced_app()
        async with client_for(app) as client:
            res = await client.post(URL, json=self.body(True), headers=DEMO_HEADERS)
        trace = res.json()["debug_trace"]
        assert [e["node"] for e in trace] == [
            "emergency_guard",
            "redact",
            "emergency_classifier",
            "classify",
            "templates",
        ]
        assert all(
            set(e)
            <= {
                "node",
                "latency_ms",
                "status",
                "model",
                "tokens_in",
                "tokens_out",
                "cost_usd",
                "prompt_version",
            }
            for e in trace
        )

    async def test_the_demo_client_gets_nothing_unless_it_asks(self):
        app, _ = traced_app()
        async with client_for(app) as client:
            res = await client.post(URL, json=self.body(False), headers=DEMO_HEADERS)
        assert res.status_code == 200 and res.json()["debug_trace"] is None

    async def test_the_gateway_never_gets_it_even_if_it_asks(self):
        app, _ = traced_app()
        async with client_for(app) as client:
            res = await client.post(URL, json=self.body(True), headers=HEADERS)
        assert res.status_code == 200 and res.json()["debug_trace"] is None

    async def test_without_options_nothing_changes_for_the_gateway(self):
        app, _ = traced_app()
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 200 and res.json()["debug_trace"] is None

    async def test_the_trace_holds_no_text_extraction_value_or_phi(self):
        provider = FakeProvider(
            [
                CLASSIFY_RX,
                extraction(medicine(raw_text=f("SECRET-OCR-LINE 9876543210"))),
                {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet"}]},
            ]
        )
        app, _ = traced_app(provider)
        body = payload(input=IMAGE_BODY)
        body["options"] = {"include_trace": True}
        async with client_for(app) as client:
            res = await client.post(URL, json=body, headers=DEMO_HEADERS)
        text = json.dumps(res.json()["debug_trace"], ensure_ascii=False)
        for forbidden in ("SECRET-OCR-LINE", "9876543210", "Dolo 650", "650 mg", "paracetamol"):
            assert forbidden not in text
        assert res.json()["extraction"] is not None  # the reply itself is unchanged

    async def test_the_demo_token_is_accepted_on_process_only(self):
        app, _ = traced_app()
        async with client_for(app) as client:
            ok = await client.post(URL, json=payload(), headers=DEMO_HEADERS)
            details = await client.post(
                "/v1/generic-details",
                json={"request_id": "x", "language": "en", "medicines": [{"name": "Dolo"}]},
                headers=DEMO_HEADERS,
            )
            wrong = await client.post(
                URL, json=payload(), headers={"X-Service-Token": "nope-nope-nope-nope"}
            )
        assert ok.status_code == 200 and details.status_code == 401 and wrong.status_code == 401

    async def test_without_a_configured_demo_token_only_the_gateway_token_works(self):
        app = create_app(make_settings())
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=DEMO_HEADERS)
        assert res.status_code == 401


class TestDemoTokenSettings:
    def test_must_be_long_and_different_from_the_service_token(self):
        from app.config import ConfigError

        with pytest.raises(ConfigError, match="at least 16"):
            make_settings(DEMO_SERVICE_TOKEN="short-token")
        with pytest.raises(ConfigError, match="must differ"):
            make_settings(
                SERVICE_TOKEN="same-token-0123456789", DEMO_SERVICE_TOKEN="same-token-0123456789"
            )
        assert make_settings(DEMO_SERVICE_TOKEN=DEMO).demo_service_token is not None

    def test_the_node_timeouts_have_sensible_defaults(self):
        s = make_settings()
        assert (
            s.node_timeout_s("vision"),
            s.node_timeout_s("cheap"),
            s.node_timeout_s("composer"),
        ) == (45.0, 10.0, 20.0)
        assert s.node_timeout_s("fast") == 5.0 and s.node_timeout_s("unknown") == 5.0
        assert make_settings(NODE_TIMEOUT_VISION_S="30").node_timeout_s("vision") == 30.0
