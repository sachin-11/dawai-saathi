"""`POST /v1/process`: auth, contract validation, pipeline results, error mapping, logging, tracing."""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.llm.factory import build_llm_router
from app.llm.fake import FakeProvider
from app.llm.pricing import ModelPrice, PricingTable
from app.llm.types import (
    LLMAuthError,
    LLMBadRequestError,
    LLMRateLimitError,
    LLMServerError,
)
from app.main import create_app
from app.observability.tracing import LangfuseTracer, observe_llm_call, trace_id_for
from app.pipeline.base import PipelineContext, PipelineOutput
from app.schemas.process import MAX_BUTTONS, MAX_REPLY_CHARS, ProcessRequest, Reply, ReplyButton
from tests.conftest import SERVICE_TOKEN, make_settings
from tests.rx_support import fake_fetch, sample_jpeg
from tests.test_tracing import FakeLangfuse

URL = "/v1/process"
HEADERS = {"X-Service-Token": SERVICE_TOKEN}
PROVIDER_BODY = "SECRET-PROVIDER-BODY-9876543210"
# The emergency classifier answers first on ordinary text; scripts for the intent call follow it.
NOT_EMERGENCY: dict[str, Any] = {"is_emergency": False, "category": None, "confidence": 0.9}


def payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "request_id": "wamid.HBgLOTE5ODc2NTQzMjEw",
        "user": {"language": "hi", "age": None, "sex": None},
        "input": {"type": "text", "text": "kya kar sakte ho?"},
        "context": {"active_medications": [{"salt": "paracetamol", "strength": "500 mg"}]},
    }
    body.update(overrides)
    return body


@asynccontextmanager
async def client_for(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


def app_with(
    provider: FakeProvider | None = None, *, pricing: PricingTable | None = None, **settings: Any
):
    config = make_settings(**settings)
    router = build_llm_router(
        config, observer=observe_llm_call, fake_provider=provider, pricing=pricing
    )
    return create_app(config, llm_router=router), provider


class TestAuth:
    async def test_missing_token_is_401(self, client: AsyncClient):
        res = await client.post(URL, json=payload())
        assert res.status_code == 401
        error = res.json()["error"]
        assert error["code"] == "UNAUTHORIZED" and error["status"] == 401
        assert "request_id" in error

    @pytest.mark.parametrize("token", ["wrong-token", "", SERVICE_TOKEN + "x", SERVICE_TOKEN[:-1]])
    async def test_wrong_token_is_401(self, client: AsyncClient, token: str):
        res = await client.post(URL, json=payload(), headers={"X-Service-Token": token})
        assert res.status_code == 401

    async def test_auth_is_checked_before_the_body_is_validated(self, client: AsyncClient):
        res = await client.post(URL, json={"nonsense": True})
        assert res.status_code == 401

    async def test_the_correct_token_is_accepted(self, client: AsyncClient):
        res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 200

    async def test_health_endpoints_stay_open(self, client: AsyncClient):
        assert (await client.get("/health/live")).status_code == 200


class TestSuccess:
    async def test_help_returns_the_help_template_with_full_meta(self, client: AsyncClient):
        res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 200
        body = res.json()
        assert body["request_id"] == payload()["request_id"]
        assert body["intent"] == "help"
        assert body["emergency"] is False
        assert body["extraction"] is None
        assert body["warnings"] == []
        assert body["reply"]["language"] == "hi"
        assert "दवाई साथी" in body["reply"]["text"]
        assert body["reply"]["buttons"] == []
        meta = body["meta"]
        assert meta["model"] == "fake-model" and meta["provider"] == "fake"
        assert meta["prompt_version"] == "reply_templates_v8,emergency_classify_v1,intent_text_v2"
        assert meta["fallback_used"] is False
        assert meta["latency_ms"] >= 0 and meta["cost_usd"] == 0
        assert meta["trace_id"] is None  # no Langfuse configured

    async def test_english_users_get_english(self, client: AsyncClient):
        body = payload(user={"language": "en"}, input={"type": "text", "text": "what can you do"})
        res = await client.post(URL, json=body, headers=HEADERS)
        assert res.json()["reply"]["language"] == "en"
        assert "I'm Dawai Saathi" in res.json()["reply"]["text"]

    async def test_off_topic_text_gets_the_static_out_of_scope_reply(self, client: AsyncClient):
        body = payload(input={"type": "text", "text": "cricket score batao"})
        res = await client.post(URL, json=body, headers=HEADERS)
        assert res.json()["intent"] == "out_of_scope"
        assert "सिर्फ़ दवाइयों" in res.json()["reply"]["text"]

    async def test_a_greeting_gets_the_welcome(self, client: AsyncClient):
        body = payload(input={"type": "text", "text": "hello"})
        res = await client.post(URL, json=body, headers=HEADERS)
        assert res.json()["intent"] == "greeting"
        assert "नमस्ते" in res.json()["reply"]["text"]

    async def test_a_voice_note_is_acknowledged_without_any_llm_call(self):
        # Audio is still a static "received" reply (STT arrives with M13). Images are read since M7.
        provider = FakeProvider()
        app, _ = app_with(provider)
        body = payload(
            input={
                "type": "audio",
                "media_url": "http://localhost:9000/b/k?s=1",
                "mime": "audio/ogg",
            }
        )
        async with client_for(app) as client:
            res = await client.post(URL, json=body, headers=HEADERS)
        assert res.status_code == 200
        assert res.json()["intent"] == "other"
        assert res.json()["meta"]["model"] is None
        assert provider.calls == []

    async def test_a_classifier_emergency_sets_the_flag_category_and_the_112_text(self):
        provider = FakeProvider([{"is_emergency": True, "category": "stroke", "confidence": 0.9}])
        app, _ = app_with(provider)
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        body = res.json()
        assert body["emergency"] is True and body["intent"] == "emergency"
        assert body["emergency_category"] == "stroke"
        assert "112" in body["reply"]["text"]
        assert len(provider.calls) == 1  # no intent call, no other LLM work

    @pytest.mark.parametrize(
        ("text", "category", "needs_14416"),
        [
            ("seene me bahut dard ho raha hai", "cardiac", False),
            ("mujhe jeena nahi hai", "self_harm", True),
        ],
    )
    async def test_a_keyword_emergency_is_answered_without_any_llm_call(
        self, text, category, needs_14416
    ):
        provider = FakeProvider()
        app, _ = app_with(provider)
        async with client_for(app) as client:
            res = await client.post(
                URL, json=payload(input={"type": "text", "text": text}), headers=HEADERS
            )
        body = res.json()
        assert body["emergency"] is True and body["intent"] == "emergency"
        assert body["emergency_category"] == category
        assert ("14416" in body["reply"]["text"]) is needs_14416
        assert "112" in body["reply"]["text"]
        assert provider.calls == []  # not a single model call
        assert body["meta"]["cost_usd"] == 0

    async def test_a_non_emergency_has_no_category(self, client: AsyncClient):
        res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.json()["emergency_category"] is None

    async def test_the_response_validates_against_the_contract(self, client: AsyncClient):
        res = await client.post(URL, json=payload(), headers=HEADERS)
        from app.schemas.process import ProcessResponse

        ProcessResponse.model_validate(res.json())

    async def test_cost_is_summed_into_meta(self):
        pricing = PricingTable({"fake-model": ModelPrice(1_000_000.0, 1_000_000.0, False)}, "t")
        app, _ = app_with(pricing=pricing)
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.json()["meta"]["cost_usd"] > 0


class TestValidation:
    @pytest.mark.parametrize(
        ("body", "needle"),
        [
            ({**payload(), "unexpected": 1}, "unexpected"),
            (payload(input={"type": "text"}), "input"),
            (payload(input={"type": "text", "text": "   "}), "input"),
            (payload(input={"type": "image"}), "input"),
            (payload(input={"type": "image", "media_url": "http://localhost:9000/x"}), "input"),
            (
                payload(
                    input={"type": "text", "text": "x", "media_url": "http://localhost:9000/x"}
                ),
                "input",
            ),
            (payload(input={"type": "text", "text": "x" * 4001}), "text"),
            (payload(input={"type": "video", "text": "x"}), "type"),
            (payload(user={"language": "fr"}), "language"),
            (payload(user={"language": "hi", "age": 200}), "age"),
            (payload(user={"language": "hi", "extra": 1}), "extra"),
            (payload(request_id="has space"), "request_id"),
            (payload(request_id="x" * 201), "request_id"),
            (payload(request_id=""), "request_id"),
            (payload(context={"active_medications": [{"salt": "a", "strength": ""}]}), "strength"),
            ({k: v for k, v in payload().items() if k != "user"}, "user"),
        ],
    )
    async def test_invalid_requests_are_422_with_the_shared_error_shape(
        self, client: AsyncClient, body, needle
    ):
        res = await client.post(URL, json=body, headers=HEADERS)
        assert res.status_code == 422
        error = res.json()["error"]
        assert error["code"] == "UNPROCESSABLE_CONTENT" or error["code"].startswith("UNPROCESSABLE")
        assert error["status"] == 422
        assert error["message"] == "Request validation failed"
        assert any(needle in detail for detail in error["details"])
        assert "request_id" in error

    async def test_validation_errors_never_echo_the_input(self, client: AsyncClient):
        secret = "my phone is 9876543210"
        body = payload(input={"type": "text", "text": secret, "media_url": "x"})
        res = await client.post(URL, json=body, headers=HEADERS)
        assert res.status_code == 422
        assert secret not in res.text and "9876543210" not in res.text

    async def test_malformed_json_is_422(self, client: AsyncClient):
        res = await client.post(
            URL, content=b"{not json", headers={**HEADERS, "content-type": "application/json"}
        )
        assert res.status_code == 422

    async def test_the_request_body_is_size_limited(self, client: AsyncClient):
        huge = payload(
            input={"type": "text", "text": "x" * 4000}, context={"active_medications": []}
        )
        huge["padding"] = "y" * (70 * 1024)
        res = await client.post(URL, json=huge, headers=HEADERS)
        assert res.status_code == 413
        assert res.json()["error"]["status"] == 413


class TestResponseConstraints:
    def reply(self, **overrides: Any) -> Reply:
        return Reply(language="en", text=overrides.pop("text", "ok"), **overrides)

    def test_text_limit_is_4096(self):
        assert self.reply(text="x" * MAX_REPLY_CHARS)
        with pytest.raises(ValidationError):
            self.reply(text="x" * (MAX_REPLY_CHARS + 1))

    def test_text_must_not_be_empty(self):
        with pytest.raises(ValidationError):
            self.reply(text="")

    def test_at_most_three_buttons(self):
        buttons = [ReplyButton(id=str(i), title=f"b{i}") for i in range(MAX_BUTTONS)]
        assert len(self.reply(buttons=buttons).buttons) == 3
        with pytest.raises(ValidationError):
            self.reply(buttons=[*buttons, ReplyButton(id="4", title="b4")])

    def test_button_title_is_at_most_20_characters(self):
        assert ReplyButton(id="a", title="x" * 20)
        with pytest.raises(ValidationError):
            ReplyButton(id="a", title="x" * 21)
        with pytest.raises(ValidationError):
            ReplyButton(id="a", title="")

    def test_button_id_is_at_most_256_characters(self):
        assert ReplyButton(id="x" * 256, title="ok")
        with pytest.raises(ValidationError):
            ReplyButton(id="x" * 257, title="ok")

    def test_request_models_forbid_extra_fields(self):
        with pytest.raises(ValidationError):
            ProcessRequest.model_validate({**payload(), "extra": 1})


class TestErrorMapping:
    async def post(self, provider: FakeProvider):
        app, _ = app_with(provider)
        async with client_for(app) as client:
            return await client.post(URL, json=payload(), headers=HEADERS)

    @pytest.mark.parametrize(
        ("errors", "status", "code"),
        [
            ([LLMServerError(PROVIDER_BODY)] * 2, 503, "LLM_UNAVAILABLE"),
            ([LLMRateLimitError(PROVIDER_BODY)] * 2, 503, "LLM_UNAVAILABLE"),
            ([LLMBadRequestError(PROVIDER_BODY)], 502, "LLM_REJECTED"),
            ([LLMAuthError(PROVIDER_BODY)], 502, "LLM_REJECTED"),
            (["nope", "still not json"], 502, "LLM_BAD_OUTPUT"),
        ],
    )
    async def test_llm_failures_map_to_clear_responses_without_leaking_details(
        self, errors, status, code
    ):
        res = await self.post(FakeProvider([NOT_EMERGENCY, *errors]))
        assert res.status_code == status
        error = res.json()["error"]
        assert error["code"] == code and error["status"] == status
        assert PROVIDER_BODY not in res.text and "9876543210" not in res.text
        assert "Traceback" not in res.text

    async def test_a_slow_pipeline_is_cut_off_with_504(self):
        class Slow:
            async def run(self, request: ProcessRequest, ctx: PipelineContext) -> PipelineOutput:
                await asyncio.sleep(5)
                raise AssertionError("unreachable")

        config = make_settings(PROCESS_TIMEOUT_S="0.05")
        app = create_app(config, pipeline=Slow())
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 504
        assert res.json()["error"]["code"] == "PROCESS_TIMEOUT"

    async def test_an_unexpected_exception_is_a_generic_500_without_a_stack_trace(self):
        class Broken:
            async def run(self, request: ProcessRequest, ctx: PipelineContext) -> PipelineOutput:
                raise RuntimeError("internal detail 9876543210")

        app = create_app(make_settings(), pipeline=Broken())
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 500
        assert "internal detail" not in res.text and "Traceback" not in res.text

    async def test_a_misconfigured_real_mode_answers_503_not_a_crash_at_startup(self):
        config = make_settings(LLM_MODE="real", LLM_PRIMARY="anthropic", ANTHROPIC_API_KEY="")
        app = create_app(config)  # must boot
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
            ready = await client.get("/health/ready")
        assert res.status_code == 503 and res.json()["error"]["code"] == "LLM_NOT_CONFIGURED"
        assert ready.json()["checks"]["llm_config"] == "fail"


class TestLoggingAndTracing:
    async def test_logs_carry_the_request_id_and_never_the_text(
        self, capsys: pytest.CaptureFixture[str]
    ):
        app, _ = app_with(None, LOG_LEVEL="info")
        text = "mera number 9876543210 hai, kya kar sakte ho"
        async with client_for(app) as client:
            res = await client.post(
                URL, json=payload(input={"type": "text", "text": text}), headers=HEADERS
            )
        assert res.status_code == 200
        logs = capsys.readouterr().out
        assert "process_done" in logs
        assert payload()["request_id"] in logs
        assert (
            "9876543210" not in logs and "mera number" not in logs and "kya kar sakte" not in logs
        )

    async def test_the_trace_id_is_returned_and_generations_are_recorded_redacted(self):
        langfuse = FakeLangfuse()
        config = make_settings()
        router = build_llm_router(config, observer=observe_llm_call)
        app = create_app(config, llm_router=router, tracer=LangfuseTracer(langfuse))
        text = "my number is 9876543210, what can you do"
        async with client_for(app) as client:
            res = await client.post(
                URL, json=payload(input={"type": "text", "text": text}), headers=HEADERS
            )
        body = res.json()
        assert body["meta"]["trace_id"] == trace_id_for(payload()["request_id"])

        # One root span, one span per graph node, and the LLM calls (generations) in between (M9).
        names = [o.kwargs["name"] for o in langfuse.observations]
        assert names == [
            "process",
            "emergency_guard",
            "redact",
            "emergency_classifier",
            "emergency_classify",
            "classify",
            "classify_intent",
            "templates",
        ]
        sent = langfuse.everything_sent()
        assert "9876543210" not in sent and "[PHONE]" in sent
        assert langfuse.flushed >= 1
        generation = langfuse.observations[names.index("classify_intent")].kwargs
        assert generation["version"] == "intent_text_v2"
        assert generation["usage_details"]["input"] > 0

    async def test_a_failed_request_still_finishes_its_trace(self):
        langfuse = FakeLangfuse()
        config = make_settings()
        provider = FakeProvider([NOT_EMERGENCY, LLMServerError(), LLMServerError()])
        router = build_llm_router(config, observer=observe_llm_call, fake_provider=provider)
        app = create_app(config, llm_router=router, tracer=LangfuseTracer(langfuse))
        async with client_for(app) as client:
            res = await client.post(URL, json=payload(), headers=HEADERS)
        assert res.status_code == 503
        assert langfuse.observations[0].ended
        assert json.loads(json.dumps(langfuse.observations[0].updates, default=str))[0][
            "output"
        ] == {"error": "unavailable"}

    async def test_the_openapi_document_describes_the_contract(self, client: AsyncClient):
        spec = (await client.get("/openapi.json")).json()
        assert "/v1/process" in spec["paths"]
        schemas = spec["components"]["schemas"]
        for name in (
            "ProcessRequest",
            "ProcessResponse",
            "Reply",
            "ReplyButton",
            "Meta",
            "Warning",
        ):
            assert name in schemas
        assert schemas["ProcessRequest"]["additionalProperties"] is False
        assert schemas["Reply"]["properties"]["buttons"]["maxItems"] == 3
        assert schemas["ReplyButton"]["properties"]["title"]["maxLength"] == 20
        assert schemas["Reply"]["properties"]["text"]["maxLength"] == 4096


class TestSafetyLayerEndToEnd:
    async def test_the_lifespan_warms_the_redaction_engine(self):
        config = make_settings()
        app = create_app(config)
        async with app.router.lifespan_context(app):
            assert app.state.redactor.enabled is True
            assert app.state.guard is not None

    async def test_no_phone_number_reaches_a_log_line_or_the_model(self, capsys):
        provider = FakeProvider()
        app, _ = app_with(provider)
        text = "mera number 9876543210 hai, aadhaar 2345 6789 0124, dawai ke baare me poochna hai"
        async with client_for(app) as client:
            res = await client.post(
                URL, json=payload(input={"type": "text", "text": text}), headers=HEADERS
            )
        assert res.status_code == 200
        everything = capsys.readouterr().out + json.dumps(
            [[m.content for m in call["messages"]] for call in provider.calls]
        )
        assert "9876543210" not in everything and "2345 6789 0124" not in everything

    async def test_an_emergency_in_an_image_request_cannot_exist(self, monkeypatch):
        # The guard runs on typed text and voice transcripts only. An image goes to the document
        # pipeline: its model calls are the image classifier / extractor, never the emergency one.
        provider = FakeProvider([{"kind": "other", "quality": "good", "confidence": 0.9}])
        app, _ = app_with(provider)
        monkeypatch.setattr(
            "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
        )
        body = payload(
            input={
                "type": "image",
                "media_url": "http://localhost:9000/b/k?s=1",
                "mime": "image/jpeg",
            }
        )
        async with client_for(app) as client:
            res = await client.post(URL, json=body, headers=HEADERS)
        assert res.json()["emergency"] is False
        assert all("is_emergency" not in str(c["response_model"]) for c in provider.calls)

    async def test_emergency_makes_no_llm_calls_and_costs_nothing(self):
        provider = FakeProvider()
        app, _ = app_with(provider)
        async with client_for(app) as client:
            res = await client.post(
                URL,
                json=payload(input={"type": "text", "text": "he is unconscious and not breathing"}),
                headers=HEADERS,
            )
        assert res.json()["emergency"] is True
        assert provider.calls == []
