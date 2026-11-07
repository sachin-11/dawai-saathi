import asyncio
import json

import pytest
from pydantic import BaseModel, Field

from app.llm.breaker import CircuitBreaker
from app.llm.fake import FakeProvider
from app.llm.pricing import ModelPrice, PricingTable
from app.llm.router import Deadline, LLMRouter, ProviderSlot
from app.llm.types import (
    LLMAuthError,
    LLMBadRequestError,
    LLMCallRecord,
    LLMConnectionError,
    LLMRateLimitError,
    LLMSchemaError,
    LLMServerError,
    LLMTimeoutError,
    LLMUnavailableError,
    Message,
    RawResult,
)


class Answer(BaseModel):
    intent: str
    confidence: float = Field(ge=0, le=1)


GOOD = {"intent": "help", "confidence": 0.9}
MODELS = {"vision": "m-vision", "text": "m-text", "cheap": "m-cheap"}
MESSAGES = [Message("system", "classify"), Message("user", "kya kar sakte ho 9876543210")]


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Setup:
    def __init__(self, primary: FakeProvider, fallback: FakeProvider | None, **router_args) -> None:
        self.clock = Clock()
        self.sleeps: list[float] = []
        self.records: list[LLMCallRecord] = []
        primary.name = "primary"
        slots = [ProviderSlot(primary, dict(MODELS), self._breaker(router_args))]
        if fallback is not None:
            fallback.name = "fallback"
            slots.append(
                ProviderSlot(
                    fallback, {"cheap": "fb-cheap", "text": "fb-text"}, self._breaker(router_args)
                )
            )
        pricing = PricingTable(
            {
                "m-cheap": ModelPrice(1.0, 2.0, False),
                "m-text": ModelPrice(3.0, 6.0, False),
                "fb-cheap": ModelPrice(10.0, 20.0, False),
            },
            "test",
        )

        async def fake_sleep(seconds: float) -> None:
            self.sleeps.append(seconds)

        self.router = LLMRouter(
            slots,
            pricing,
            call_timeout_s=router_args.get("call_timeout_s", 20.0),
            max_attempts=router_args.get("max_attempts", 2),
            observer=self.records.append,
            sleep=fake_sleep,
            rng=lambda: 0.5,
        )
        self.primary = primary
        self.fallback = fallback

    def _breaker(self, args: dict) -> CircuitBreaker:
        return CircuitBreaker(args.get("breaker_threshold", 5), 60.0, clock=self.clock)

    async def ask(self, role="cheap", *, structured=True, **kwargs):
        return await self.router.generate(
            role,
            MESSAGES,
            name="classify",
            response_model=Answer if structured else None,
            prompt_version="p_v1",
            **kwargs,
        )


class TestHappyPath:
    async def test_returns_parsed_answer_with_cost_and_provider(self):
        s = Setup(FakeProvider([GOOD]), None)
        result = await s.ask()
        assert isinstance(result.parsed, Answer)
        assert result.parsed.intent == "help"
        assert result.provider == "primary"
        assert result.model == "m-cheap"
        assert result.fallback_used is False
        assert result.attempts == 1
        # fake tokens: input = words in both messages (1 + 5), output = words in the JSON (2)
        assert result.input_tokens == 6
        assert result.cost_usd == pytest.approx((6 * 1.0 + result.output_tokens * 2.0) / 1_000_000)

    async def test_unstructured_call_returns_text(self):
        s = Setup(FakeProvider(["hello there"]), None)
        result = await s.ask(structured=False)
        assert result.text == "hello there"
        assert result.parsed is None

    async def test_model_comes_from_the_role(self):
        s = Setup(FakeProvider([GOOD, GOOD, GOOD]), None)
        for role in ("vision", "text", "cheap"):
            result = await s.ask(role)
            assert result.model == MODELS[role]
        assert [call["model"] for call in s.primary.calls] == ["m-vision", "m-text", "m-cheap"]

    async def test_markdown_fenced_json_is_accepted(self):
        s = Setup(FakeProvider(['```json\n{"intent": "help", "confidence": 0.8}\n```']), None)
        result = await s.ask()
        assert isinstance(result.parsed, Answer)
        assert len(s.primary.calls) == 1  # no repair needed

    async def test_call_parameters_reach_the_provider(self):
        s = Setup(FakeProvider([GOOD]), None)
        await s.router.generate(
            "cheap", MESSAGES, name="x", temperature=0.2, max_tokens=77, response_model=Answer
        )
        call = s.primary.calls[0]
        assert (call["temperature"], call["max_tokens"], call["response_model"]) == (
            0.2,
            77,
            Answer,
        )


class TestRetryAndFallback:
    async def test_retries_a_transient_error_on_the_same_provider(self):
        s = Setup(FakeProvider([LLMServerError(), GOOD]), FakeProvider([GOOD]))
        result = await s.ask()
        assert result.provider == "primary"
        assert result.fallback_used is False
        assert result.attempts == 2
        assert len(s.primary.calls) == 2
        assert s.fallback.calls == []
        assert len(s.sleeps) == 1

    async def test_backoff_has_jitter_and_grows(self):
        s = Setup(FakeProvider([LLMTimeoutError(), LLMTimeoutError(), GOOD]), None, max_attempts=3)
        await s.ask()
        assert s.sleeps == [0.375, 0.75]  # equal jitter with rng=0.5: 0.75 * (0.5, 1.0) * ...

    @pytest.mark.parametrize(
        "error",
        [LLMTimeoutError(), LLMRateLimitError(), LLMServerError(), LLMConnectionError()],
        ids=["timeout", "429", "5xx", "connection"],
    )
    async def test_falls_back_when_the_primary_keeps_failing(self, error):
        s = Setup(FakeProvider([error, error]), FakeProvider([GOOD]))
        result = await s.ask()
        assert result.fallback_used is True
        assert result.provider == "fallback"
        assert result.model == "fb-cheap"  # the FALLBACK provider's own model id
        assert len(s.primary.calls) == 2  # max_attempts
        assert len(s.fallback.calls) == 1

    async def test_primary_timeout_then_fallback_marks_fallback_used_in_the_trace_records(self):
        s = Setup(FakeProvider([LLMTimeoutError(), LLMTimeoutError()]), FakeProvider([GOOD]))
        await s.ask()
        outcomes = [(r.provider, r.ok, r.error_kind) for r in s.records]
        assert outcomes == [
            ("primary", False, "timeout"),
            ("primary", False, "timeout"),
            ("fallback", True, None),
        ]

    async def test_400_does_not_fall_back(self):
        s = Setup(FakeProvider([LLMBadRequestError()]), FakeProvider([GOOD]))
        with pytest.raises(LLMBadRequestError):
            await s.ask()
        assert len(s.primary.calls) == 1  # not even retried
        assert s.fallback.calls == []

    async def test_auth_error_does_not_fall_back(self):
        s = Setup(FakeProvider([LLMAuthError()]), FakeProvider([GOOD]))
        with pytest.raises(LLMAuthError):
            await s.ask()
        assert s.fallback.calls == []

    async def test_all_providers_failing_raises_unavailable_with_the_cause(self):
        s = Setup(FakeProvider([LLMServerError()] * 2), FakeProvider([LLMRateLimitError()] * 2))
        with pytest.raises(LLMUnavailableError) as info:
            await s.ask()
        assert isinstance(info.value.__cause__, LLMRateLimitError)

    async def test_works_without_a_fallback_provider(self):
        s = Setup(FakeProvider([LLMServerError(), LLMServerError()]), None)
        with pytest.raises(LLMUnavailableError):
            await s.ask()

    async def test_a_fallback_without_a_model_for_the_role_is_skipped(self):
        s = Setup(FakeProvider([LLMServerError()] * 2), FakeProvider([GOOD]))
        with pytest.raises(LLMUnavailableError):
            await s.ask("vision")  # the fallback has no vision model configured
        assert s.fallback.calls == []


class TestStructuredOutput:
    async def test_one_repair_retry_then_success(self):
        bad = {"intent": "help", "confidence": 7}  # confidence out of range
        s = Setup(FakeProvider([bad, GOOD]), None)
        result = await s.ask()
        assert isinstance(result.parsed, Answer)
        assert len(s.primary.calls) == 2
        repair = s.primary.calls[1]["messages"]
        assert repair[-1].role == "user"
        assert "did not match the required structure" in repair[-1].content
        assert "confidence" in repair[-1].content  # the field path is shown
        assert repair[-2].role == "assistant"

    async def test_the_repair_prompt_never_echoes_the_bad_value(self):
        secret = "my-secret-phone-9876543210"
        s = Setup(FakeProvider([{"intent": 5, "confidence": secret}, GOOD]), None)
        await s.ask()
        repair_text = s.primary.calls[1]["messages"][-1].content
        assert secret not in repair_text

    async def test_not_json_is_repaired_too(self):
        s = Setup(FakeProvider(["sorry, I cannot do that", GOOD]), None)
        result = await s.ask()
        assert isinstance(result.parsed, Answer)
        assert "not valid JSON" in s.primary.calls[1]["messages"][-1].content

    async def test_still_invalid_after_the_repair_raises_schema_error_and_does_not_fall_back(self):
        bad = {"intent": "help", "confidence": 7}
        s = Setup(FakeProvider([bad, bad]), FakeProvider([GOOD]))
        with pytest.raises(LLMSchemaError):
            await s.ask()
        assert len(s.primary.calls) == 2  # exactly one repair attempt
        assert s.fallback.calls == []

    async def test_repair_cost_is_added_to_the_result(self):
        bad = {"intent": "help", "confidence": 7}
        s = Setup(FakeProvider([bad, GOOD]), None)
        result = await s.ask()
        first_in = sum(len(m.content.split()) for m in MESSAGES)
        assert result.input_tokens > first_in  # includes the repair call's input
        assert result.cost_usd > 0
        assert result.attempts == 2


class TestCircuitBreaker:
    async def test_opens_after_n_consecutive_failures_and_skips_the_provider(self):
        failing = FakeProvider([LLMServerError()] * 20)
        s = Setup(failing, FakeProvider([GOOD] * 20), breaker_threshold=2, max_attempts=1)
        for _ in range(2):  # two requests, one failed attempt each: the breaker opens
            assert (await s.ask()).fallback_used is True
        calls_before = len(s.primary.calls)

        result = await s.ask()  # the primary is skipped without being called
        assert result.fallback_used is True
        assert len(s.primary.calls) == calls_before

    async def test_lets_one_probe_through_after_the_cooldown_and_closes_on_success(self):
        s = Setup(
            FakeProvider([LLMServerError(), LLMServerError(), GOOD, GOOD]),
            FakeProvider([GOOD] * 5),
            breaker_threshold=2,
            max_attempts=1,
        )
        await s.ask()
        await s.ask()  # open
        s.clock.now += 61  # cooldown over
        result = await s.ask()  # the probe goes to the primary and succeeds
        assert result.provider == "primary"
        assert (await s.ask()).provider == "primary"  # closed again

    async def test_failed_probe_reopens_the_breaker(self):
        s = Setup(
            FakeProvider([LLMServerError()] * 3),
            FakeProvider([GOOD] * 5),
            breaker_threshold=2,
            max_attempts=1,
        )
        await s.ask()
        await s.ask()
        s.clock.now += 61
        await s.ask()  # probe fails
        calls = len(s.primary.calls)
        await s.ask()  # open again: skipped
        assert len(s.primary.calls) == calls

    async def test_a_400_does_not_count_against_the_provider(self):
        s = Setup(
            FakeProvider([LLMBadRequestError()] * 3 + [GOOD]),
            FakeProvider([GOOD]),
            breaker_threshold=2,
            max_attempts=1,
        )
        for _ in range(3):
            with pytest.raises(LLMBadRequestError):
                await s.ask()
        assert (await s.ask()).provider == "primary"  # breaker never opened

    async def test_a_schema_failure_does_not_count_against_the_provider(self):
        bad = {"intent": "help", "confidence": 7}
        s = Setup(
            FakeProvider([bad, bad, bad, bad, GOOD]), FakeProvider([GOOD]), breaker_threshold=2
        )
        for _ in range(2):
            with pytest.raises(LLMSchemaError):
                await s.ask()
        assert (await s.ask()).provider == "primary"


class TestDeadline:
    async def test_each_attempt_gets_at_most_the_remaining_budget(self):
        s = Setup(FakeProvider([GOOD]), None, call_timeout_s=30.0)
        await s.ask(deadline=Deadline(5.0))
        assert s.primary.calls[0]["timeout_s"] <= 5.0

    async def test_an_exhausted_budget_fails_without_calling_the_model(self):
        s = Setup(FakeProvider([GOOD]), FakeProvider([GOOD]))
        with pytest.raises(LLMUnavailableError):
            await s.ask(deadline=Deadline(0.0))
        assert s.primary.calls == [] and s.fallback.calls == []

    async def test_a_hanging_provider_is_cut_off_by_the_call_timeout(self):
        class Hanging(FakeProvider):
            async def generate(self, *args, **kwargs) -> RawResult:
                await asyncio.sleep(10)
                raise AssertionError("unreachable")

        slots = [ProviderSlot(Hanging(), dict(MODELS), CircuitBreaker(5, 60.0))]
        router = LLMRouter(
            slots,
            PricingTable({}, "t"),
            call_timeout_s=0.05,
            max_attempts=1,
            sleep=lambda _s: asyncio.sleep(0),
        )
        with pytest.raises(LLMUnavailableError) as info:
            await router.generate("cheap", MESSAGES, name="x")
        assert isinstance(info.value.__cause__, LLMTimeoutError)


class TestObserver:
    async def test_records_each_attempt_with_numbers_and_content(self):
        s = Setup(FakeProvider([LLMServerError(), GOOD]), None)
        await s.ask()
        failed, ok = s.records
        assert (failed.ok, failed.error_kind, failed.attempt) == (False, "server_error", 1)
        assert (ok.ok, ok.attempt, ok.prompt_version) == (True, 2, "p_v1")
        assert ok.input_tokens > 0 and ok.cost_usd > 0
        assert ok.messages == tuple(MESSAGES)
        assert ok.output_text == json.dumps(GOOD)

    async def test_a_broken_observer_never_breaks_the_request(self):
        s = Setup(FakeProvider([GOOD]), None)

        def boom(_record: LLMCallRecord) -> None:
            raise RuntimeError("tracing is down")

        s.router._observer = boom
        result = await s.ask()
        assert isinstance(result.parsed, Answer)

    async def test_an_unconfigured_router_is_rejected(self):
        from app.llm.types import LLMConfigError

        with pytest.raises(LLMConfigError):
            LLMRouter([], PricingTable({}, "t"), call_timeout_s=1, max_attempts=1)
