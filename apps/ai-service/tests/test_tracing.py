"""Langfuse tracing with a FAKE Langfuse client: nothing leaves the process."""

import json
from typing import Any

from app.llm.types import ImageInput, LLMCallRecord, Message
from app.observability.tracing import (
    LangfuseTracer,
    NoopTracer,
    bind_session,
    build_tracer,
    observe_llm_call,
    trace_id_for,
)
from tests.conftest import make_settings


class FakeObservation:
    def __init__(self, kwargs: dict[str, Any]) -> None:
        self.kwargs = kwargs
        self.updates: list[dict[str, Any]] = []
        self.ended = False

    def update(self, **kwargs: Any) -> None:
        self.updates.append(kwargs)

    def end(self, **_kwargs: Any) -> None:
        self.ended = True


class FakeLangfuse:
    def __init__(self, fail: bool = False) -> None:
        self.observations: list[FakeObservation] = []
        self.flushed = 0
        self.shut_down = False
        self.fail = fail

    def create_trace_id(self, *, seed: str | None = None) -> str:
        return trace_id_for(seed or "")

    def start_observation(self, **kwargs: Any) -> FakeObservation:
        if self.fail:
            raise RuntimeError("langfuse is down")
        observation = FakeObservation(kwargs)
        self.observations.append(observation)
        return observation

    def flush(self) -> None:
        self.flushed += 1

    def shutdown(self) -> None:
        self.shut_down = True

    def everything_sent(self) -> str:
        """All data handed to the SDK, as one string, for leak checks."""
        return json.dumps(
            [[o.kwargs, o.updates] for o in self.observations], default=str, ensure_ascii=False
        )


def record(**overrides: Any) -> LLMCallRecord:
    base: dict[str, Any] = {
        "name": "classify_intent",
        "provider": "anthropic",
        "model": "m-cheap",
        "attempt": 1,
        "ok": True,
        "error_kind": None,
        "input_tokens": 120,
        "output_tokens": 15,
        "latency_ms": 340,
        "cost_usd": 0.00042,
        "prompt_version": "intent_text_v1",
        "messages": (
            Message("system", "classify"),
            Message("user", "my number is 9876543210, mail a@b.com"),
        ),
        "images": (),
        "output_text": '{"intent": "help", "note": "call 9876543210"}',
    }
    base.update(overrides)
    return LLMCallRecord(**base)


class TestTraceIds:
    def test_deterministic_32_hex_derived_from_the_request_id(self):
        assert trace_id_for("wamid.ABC") == trace_id_for("wamid.ABC")
        assert trace_id_for("wamid.ABC") != trace_id_for("wamid.XYZ")
        assert len(trace_id_for("wamid.ABC")) == 32
        int(trace_id_for("wamid.ABC"), 16)


class TestNoop:
    def test_no_keys_means_a_noop_tracer(self):
        tracer = build_tracer(make_settings())
        assert isinstance(tracer, NoopTracer)

    def test_noop_session_has_no_trace_id_and_does_nothing(self):
        session = NoopTracer().start("req-1", "process", {"text": "x"})
        assert session.trace_id is None
        session.generation(record())
        session.finish({"a": 1})

    def test_only_one_key_is_still_a_noop(self):
        settings = make_settings(LANGFUSE_PUBLIC_KEY="pk-only")
        assert isinstance(build_tracer(settings), NoopTracer)
        assert settings.langfuse_enabled is False

    def test_blank_keys_are_treated_as_unset(self):
        settings = make_settings(LANGFUSE_PUBLIC_KEY="", LANGFUSE_SECRET_KEY="")
        assert isinstance(build_tracer(settings), NoopTracer)


class TestLangfuseTracer:
    def test_one_trace_per_request_with_a_derived_trace_id(self):
        client = FakeLangfuse()
        session = LangfuseTracer(client).start("wamid.1", "process", {"input_type": "text"})
        assert session.trace_id == trace_id_for("wamid.1")
        root = client.observations[0]
        assert root.kwargs["name"] == "process"
        assert root.kwargs["trace_context"] == {"trace_id": trace_id_for("wamid.1")}

    def test_a_generation_carries_model_tokens_cost_latency_and_prompt_version(self):
        client = FakeLangfuse()
        session = LangfuseTracer(client).start("r1", "process", {})
        session.generation(record())

        generation = client.observations[1]
        assert generation.ended
        sent = generation.kwargs
        assert sent["as_type"] == "generation"
        assert sent["model"] == "m-cheap"
        assert sent["usage_details"] == {"input": 120, "output": 15}
        assert sent["cost_details"] == {"total": 0.00042}
        assert sent["version"] == "intent_text_v1"
        assert sent["metadata"]["latency_ms"] == 340
        assert sent["metadata"]["provider"] == "anthropic"
        assert sent["trace_context"] == {"trace_id": trace_id_for("r1")}

    def test_inputs_and_outputs_are_redacted_before_they_are_sent(self):
        client = FakeLangfuse()
        session = LangfuseTracer(client).start("r1", "process", {"text": "call 9876543210"})
        session.generation(record())

        sent = client.everything_sent()
        assert "9876543210" not in sent
        assert "a@b.com" not in sent
        assert "[PHONE]" in sent and "[EMAIL]" in sent

    def test_images_are_never_uploaded_only_a_placeholder(self):
        import base64

        client = FakeLangfuse()
        image = ImageInput(data=b"\xff\xd8 SECRET IMAGE BYTES " * 100, mime="image/jpeg")
        session = LangfuseTracer(client).start("r1", "process", {})
        session.generation(record(images=(image,)))

        sent = client.everything_sent()
        assert "SECRET IMAGE BYTES" not in sent
        assert base64.b64encode(image.data).decode()[:40] not in sent
        assert image.describe() in sent  # "[image: image/jpeg, 2 KB]"

    def test_a_failed_call_is_traced_as_an_error(self):
        client = FakeLangfuse()
        session = LangfuseTracer(client).start("r1", "process", {})
        session.generation(record(ok=False, error_kind="timeout", output_text=None))
        sent = client.observations[1].kwargs
        assert sent["level"] == "ERROR" and sent["status_message"] == "timeout"

    def test_finish_redacts_the_output_ends_the_root_and_flushes(self):
        client = FakeLangfuse()
        session = LangfuseTracer(client).start("r1", "process", {})
        session.finish({"intent": "help", "debug": "9876543210"})

        root = client.observations[0]
        assert root.ended and client.flushed == 1
        assert "9876543210" not in json.dumps(root.updates)

    def test_a_broken_langfuse_never_breaks_the_request(self):
        tracer = LangfuseTracer(FakeLangfuse(fail=True))
        session = tracer.start("r1", "process", {})  # falls back to a no-op session
        assert session.trace_id is None
        session.generation(record())
        session.finish({})

    def test_flush_and_shutdown_are_forwarded(self):
        client = FakeLangfuse()
        tracer = LangfuseTracer(client)
        tracer.flush()
        tracer.shutdown()
        assert client.flushed == 1 and client.shut_down

    def test_an_injected_client_enables_tracing_without_keys(self):
        assert isinstance(build_tracer(make_settings(), client=FakeLangfuse()), LangfuseTracer)


class TestRouterObserver:
    def test_llm_calls_go_to_the_current_requests_trace(self):
        client = FakeLangfuse()
        bind_session(LangfuseTracer(client).start("r1", "process", {}))
        observe_llm_call(record())
        assert len(client.observations) == 2  # root + generation

    def test_without_a_bound_session_nothing_happens(self):
        bind_session(NoopTracer().start("r", "p", {}))
        observe_llm_call(record())
