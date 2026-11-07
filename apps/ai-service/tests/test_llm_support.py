"""Breaker, pricing, fake provider, redaction and disclaimers: the small building blocks."""

import json
from pathlib import Path
from typing import ClassVar

import pytest

from app.llm.breaker import CircuitBreaker
from app.llm.fake import FakeProvider, FakeRule, default_fake_response
from app.llm.pricing import DEFAULT_PRICING_PATH, ModelPrice, PricingTable
from app.llm.types import ImageInput, LLMServerError, Message
from app.pipeline.minimal import IntentResult
from app.safety.disclaimers import DISCLAIMERS, add_disclaimer
from app.safety.redaction import redact_text, redact_value
from app.schemas.process import MAX_REPLY_CHARS, Language


class TestCircuitBreaker:
    def make(self, threshold: int = 3, cooldown: float = 60.0):
        clock = {"now": 0.0}
        return CircuitBreaker(threshold, cooldown, clock=lambda: clock["now"]), clock

    def test_starts_closed(self):
        breaker, _ = self.make()
        assert breaker.allow() and not breaker.is_open

    def test_opens_after_the_threshold_of_consecutive_failures(self):
        breaker, _ = self.make(threshold=3)
        for _ in range(2):
            breaker.record_failure()
        assert breaker.allow()
        breaker.record_failure()
        assert not breaker.allow() and breaker.is_open

    def test_a_success_resets_the_failure_count(self):
        breaker, _ = self.make(threshold=3)
        breaker.record_failure()
        breaker.record_failure()
        breaker.record_success()
        breaker.record_failure()
        breaker.record_failure()
        assert breaker.allow()  # only 2 consecutive failures since the success

    def test_stays_open_during_the_cooldown_then_allows_exactly_one_probe(self):
        breaker, clock = self.make(threshold=1, cooldown=60)
        breaker.record_failure()
        clock["now"] = 59
        assert not breaker.allow()
        clock["now"] = 61
        assert breaker.allow()  # the probe
        assert not breaker.allow()  # a second concurrent call is still refused

    def test_probe_success_closes_probe_failure_reopens(self):
        breaker, clock = self.make(threshold=1, cooldown=60)
        breaker.record_failure()
        clock["now"] = 61
        breaker.allow()
        breaker.record_success()
        assert breaker.allow() and not breaker.is_open

        breaker.record_failure()
        clock["now"] = 200
        breaker.allow()
        breaker.record_failure()  # probe fails
        assert not breaker.allow()
        clock["now"] = 261
        assert breaker.allow()


class TestPricing:
    table = PricingTable({"m": ModelPrice(3.0, 15.0, False)}, "test")

    def test_cost_is_tokens_times_price_per_million(self):
        assert self.table.cost_usd("m", 1_000_000, 0) == pytest.approx(3.0)
        assert self.table.cost_usd("m", 0, 1_000_000) == pytest.approx(15.0)
        assert self.table.cost_usd("m", 2_000, 500) == pytest.approx(0.006 + 0.0075)

    def test_zero_tokens_cost_nothing(self):
        assert self.table.cost_usd("m", 0, 0) == 0.0

    def test_an_unknown_model_costs_zero_and_never_fails(self):
        assert self.table.cost_usd("not-in-table", 500, 500) == 0.0

    def test_the_shipped_pricing_file_loads_and_is_marked_placeholder(self):
        table = PricingTable.load(DEFAULT_PRICING_PATH)
        assert table.version.endswith("placeholder")
        price = table.price_of("claude-sonnet-5-5")
        assert price is not None and price.placeholder is True
        fake = table.price_of("fake-model")
        assert fake is not None and fake.input_per_mtok == 0 and fake.output_per_mtok == 0

    def test_a_malformed_pricing_file_is_rejected(self, tmp_path: Path):
        bad = tmp_path / "pricing.yaml"
        bad.write_text("version: x\n", encoding="utf-8")
        with pytest.raises(ValueError, match="models"):
            PricingTable.load(bad)

    def test_loads_prices_from_a_custom_file(self, tmp_path: Path):
        path = tmp_path / "pricing.yaml"
        path.write_text(
            "version: v\nmodels:\n  a: {input_per_mtok: 1, output_per_mtok: 2}\n", encoding="utf-8"
        )
        table = PricingTable.load(path)
        assert table.cost_usd("a", 1_000_000, 1_000_000) == pytest.approx(3.0)


class TestFakeProvider:
    messages: ClassVar[list[Message]] = [
        Message("system", "s"),
        Message("user", "What can you do?"),
    ]

    async def generate(self, provider: FakeProvider, **kwargs):
        args = {"model": "m", "temperature": 0, "max_tokens": 10, "timeout_s": 1, **kwargs}
        return await provider.generate(self.messages, **args)

    async def test_default_intent_heuristic_is_deterministic(self):
        provider = FakeProvider()
        first = await self.generate(provider, response_model=IntentResult)
        second = await self.generate(provider, response_model=IntentResult)
        assert first.text == second.text
        assert json.loads(first.text) == {"intent": "help", "confidence": 0.9}

    @pytest.mark.parametrize(
        ("text", "intent"),
        [
            ("kya kar sakte ho", "help"),
            ("मदद चाहिए", "help"),
            ("please read my prescription", "prescription"),
            ("explain my blood test", "lab_report"),
            ("sasta generic dawai?", "generic_query"),
            ("I have chest pain", "emergency"),
            ("hello", "other"),
        ],
    )
    def test_heuristic_intents(self, text, intent):
        reply = default_fake_response([Message("user", text)], IntentResult)
        assert json.loads(reply)["intent"] == intent

    async def test_script_steps_are_consumed_in_order_and_errors_are_raised(self):
        provider = FakeProvider(["one", {"a": 1}, LLMServerError()])
        assert (await self.generate(provider)).text == "one"
        assert json.loads((await self.generate(provider)).text) == {"a": 1}
        with pytest.raises(LLMServerError):
            await self.generate(provider)

    async def test_fixture_rules_drive_the_answers(self, tmp_path: Path):
        fixture = tmp_path / "rules.json"
        fixture.write_text(
            json.dumps([{"match": "chest", "response": {"intent": "emergency", "confidence": 1}}]),
            encoding="utf-8",
        )
        provider = FakeProvider.from_fixture(fixture)
        result = await provider.generate(
            [Message("user", "My CHEST hurts")],
            model="m",
            temperature=0,
            max_tokens=5,
            timeout_s=1,
            response_model=IntentResult,
        )
        assert json.loads(result.text)["intent"] == "emergency"

    async def test_it_records_every_call_for_assertions(self):
        provider = FakeProvider()
        await self.generate(provider, images=[ImageInput(b"x", "image/png")])
        assert provider.calls[0]["images"] == 1
        assert provider.calls[0]["messages"] == self.messages

    def test_rules_can_return_raw_strings(self):
        provider = FakeProvider(rules=[FakeRule("x", "raw text")])
        assert provider._answer_from_rules([Message("user", "has x in it")]) == "raw text"


class TestRedaction:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("call 9876543210 now", "call [REDACTED_PHONE] now"),
            ("+91 98765 43210", "[REDACTED_PHONE]"),
            ("919876543210", "[REDACTED_PHONE]"),
            ("mail ramesh.k@example.co.in", "mail [REDACTED_EMAIL]"),
            ("aadhaar 2345 6789 0123", "aadhaar [REDACTED_AADHAAR]"),
            ("pin 411001", "pin [REDACTED_PIN]"),
            ("Dolo 650 twice a day", "Dolo 650 twice a day"),
            ("दवाई कब लेनी है", "दवाई कब लेनी है"),
        ],
    )
    def test_redact_text(self, text, expected):
        assert redact_text(text) == expected

    def test_redaction_is_idempotent(self):
        once = redact_text("9876543210 and 411001")
        assert redact_text(once) == once

    def test_redact_value_walks_nested_structures(self):
        data = {"a": ["call 9876543210", {"b": "x@y.com"}], "n": 5, "t": ("411001",)}
        assert redact_value(data) == {
            "a": ["call [REDACTED_PHONE]", {"b": "[REDACTED_EMAIL]"}],
            "n": 5,
            "t": ["[REDACTED_PIN]"],
        }

    def test_redact_value_stops_at_absurd_depth(self):
        nested: object = "9876543210"
        for _ in range(20):
            nested = [nested]
        assert "9876543210" not in json.dumps(redact_value(nested))


class TestDisclaimers:
    @pytest.mark.parametrize("language", list(Language))
    def test_appends_the_disclaimer_in_the_users_language(self, language):
        text = add_disclaimer("Take it after food.", language)
        assert text.startswith("Take it after food.")
        assert text.endswith(DISCLAIMERS[language])

    def test_is_idempotent(self):
        once = add_disclaimer("body", Language.en)
        assert add_disclaimer(once, Language.en) == once

    def test_never_exceeds_the_whatsapp_limit_and_never_cuts_the_disclaimer(self):
        text = add_disclaimer("x" * 6000, Language.hi)
        assert len(text) <= MAX_REPLY_CHARS
        assert text.endswith(DISCLAIMERS[Language.hi])
        assert "…" in text

    def test_hindi_and_english_disclaimers_say_not_a_doctor(self):
        assert "not a doctor" in DISCLAIMERS[Language.en]
        assert "डॉक्टर नहीं" in DISCLAIMERS[Language.hi]
