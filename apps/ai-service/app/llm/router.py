"""`LLMRouter`: what the rest of the app uses to talk to a model.

Responsibilities (CLAUDE.md §8, M5):
  * pick the model for a ROLE (vision / text / cheap) from configuration: no model id lives in code
  * try the primary provider, then the fallback, on timeouts, 429, 5xx and connection errors, and
    NOT on 400s or bad structured output (retrying a wrong request elsewhere just fails twice)
  * retry inside a provider with exponential backoff + jitter, within the request's deadline
  * skip a provider whose circuit breaker is open
  * structured output: validate against a Pydantic model, ONE repair attempt, then LLMSchemaError
  * price every call and report every attempt to an observer (tracing)
"""

import asyncio
import json
import random
import re
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace

import structlog
from pydantic import BaseModel, ValidationError

from app.llm.breaker import CircuitBreaker
from app.llm.pricing import PricingTable
from app.llm.types import (
    ImageInput,
    LLMCallRecord,
    LLMConfigError,
    LLMError,
    LLMProvider,
    LLMResult,
    LLMSchemaError,
    LLMTimeoutError,
    LLMUnavailableError,
    Message,
    ModelRole,
    RawResult,
)

_logger = structlog.get_logger(__name__)

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)

Observer = Callable[[LLMCallRecord], None]
Sleep = Callable[[float], Awaitable[None]]


class Deadline:
    """The time budget of one request, shared by every LLM call it makes."""

    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._ends_at = clock() + seconds

    def remaining(self) -> float:
        return max(0.0, self._ends_at - self._clock())


@dataclass(slots=True)
class ProviderSlot:
    """A provider plus the model id to use for each role, and its circuit breaker."""

    provider: LLMProvider
    models: dict[ModelRole, str]
    breaker: CircuitBreaker


def _strip_fences(text: str) -> str:
    match = _FENCE.match(text)
    return match.group(1) if match else text.strip()


def _describe_validation_error(error: ValidationError) -> str:
    """Field paths and messages only: never the offending input (it may be user data)."""
    return "; ".join(
        f"{'.'.join(str(part) for part in item['loc']) or '(root)'}: {item['msg']}"
        for item in error.errors(include_input=False, include_url=False)
    )


class LLMRouter:
    def __init__(
        self,
        slots: Sequence[ProviderSlot],
        pricing: PricingTable,
        *,
        call_timeout_s: float,
        max_attempts: int,
        observer: Observer | None = None,
        sleep: Sleep = asyncio.sleep,
        rng: Callable[[], float] = random.random,
        base_backoff_s: float = 0.5,
        max_backoff_s: float = 4.0,
    ) -> None:
        if not slots:
            raise LLMConfigError("at least one provider is required")
        self._slots = list(slots)
        self._pricing = pricing
        self._call_timeout_s = call_timeout_s
        self._max_attempts = max_attempts
        self._observer = observer
        self._sleep = sleep
        self._rng = rng
        self._base_backoff_s = base_backoff_s
        self._max_backoff_s = max_backoff_s

    @property
    def provider_names(self) -> list[str]:
        return [slot.provider.name for slot in self._slots]

    async def generate(
        self,
        role: ModelRole,
        messages: list[Message],
        *,
        name: str,
        temperature: float = 0.0,
        max_tokens: int = 512,
        response_model: type[BaseModel] | None = None,
        images: list[ImageInput] | None = None,
        prompt_version: str | None = None,
        deadline: Deadline | None = None,
    ) -> LLMResult:
        last_error: LLMError | None = None
        for index, slot in enumerate(self._slots):
            model = slot.models.get(role)
            if model is None:
                _logger.warning(
                    "llm_model_missing_for_role", provider=slot.provider.name, role=role
                )
                continue
            if not slot.breaker.allow():
                _logger.warning("llm_provider_skipped_breaker_open", provider=slot.provider.name)
                continue
            try:
                result = await self._run_on_provider(
                    slot,
                    model,
                    messages,
                    name=name,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    response_model=response_model,
                    images=images,
                    prompt_version=prompt_version,
                    deadline=deadline,
                )
            except LLMError as error:
                if not error.fallback_ok:
                    raise  # bad request / auth / schema: another provider will not fix it
                last_error = error
                _logger.warning(
                    "llm_provider_failed",
                    provider=slot.provider.name,
                    error_kind=error.kind,
                    will_fall_back=index < len(self._slots) - 1,
                )
                continue
            return replace(result, fallback_used=index > 0)

        raise LLMUnavailableError("no LLM provider could answer") from last_error

    # ------------------------------------------------------------------ one provider

    async def _run_on_provider(
        self,
        slot: ProviderSlot,
        model: str,
        messages: list[Message],
        *,
        name: str,
        temperature: float,
        max_tokens: int,
        response_model: type[BaseModel] | None,
        images: list[ImageInput] | None,
        prompt_version: str | None,
        deadline: Deadline | None,
    ) -> LLMResult:
        raw, attempts = await self._call_with_retries(
            slot,
            model,
            messages,
            name=name,
            temperature=temperature,
            max_tokens=max_tokens,
            response_model=response_model,
            images=images,
            prompt_version=prompt_version,
            deadline=deadline,
        )
        if response_model is None:
            return self._result(raw, model, None, attempts, extra=None)

        parsed, error_text = self._parse(raw.text, response_model)
        if parsed is not None:
            return self._result(raw, model, parsed, attempts, extra=None)

        # One repair attempt: show the model what was wrong (field paths only) and ask again.
        repair_messages = [
            *messages,
            Message("assistant", raw.text),
            Message(
                "user",
                "Your previous answer did not match the required structure. "
                f"Problems: {error_text}. Reply again with ONLY a valid answer.",
            ),
        ]
        repair_raw = await self._single_call(
            slot,
            model,
            repair_messages,
            name=f"{name}.repair",
            temperature=temperature,
            max_tokens=max_tokens,
            response_model=response_model,
            images=images,
            prompt_version=prompt_version,
            deadline=deadline,
            attempt=attempts + 1,
        )
        parsed, _ = self._parse(repair_raw.text, response_model)
        if parsed is None:
            raise LLMSchemaError("the model did not return a valid structured answer")
        return self._result(raw, model, parsed, attempts + 1, extra=repair_raw)

    async def _call_with_retries(
        self,
        slot: ProviderSlot,
        model: str,
        messages: list[Message],
        *,
        name: str,
        temperature: float,
        max_tokens: int,
        response_model: type[BaseModel] | None,
        images: list[ImageInput] | None,
        prompt_version: str | None,
        deadline: Deadline | None,
    ) -> tuple[RawResult, int]:
        for attempt in range(1, self._max_attempts + 1):
            try:
                raw = await self._single_call(
                    slot,
                    model,
                    messages,
                    name=name,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    response_model=response_model,
                    images=images,
                    prompt_version=prompt_version,
                    deadline=deadline,
                    attempt=attempt,
                )
            except LLMError as error:
                if not error.retryable or attempt == self._max_attempts:
                    raise
                delay = self._backoff(attempt, deadline)
                if delay is None:
                    raise  # the request budget is used up: do not sleep through it
                await self._sleep(delay)
                continue
            return raw, attempt
        raise LLMTimeoutError()  # unreachable: the loop returns or raises

    async def _single_call(
        self,
        slot: ProviderSlot,
        model: str,
        messages: list[Message],
        *,
        name: str,
        temperature: float,
        max_tokens: int,
        response_model: type[BaseModel] | None,
        images: list[ImageInput] | None,
        prompt_version: str | None,
        deadline: Deadline | None,
        attempt: int,
    ) -> RawResult:
        timeout_s = self._call_timeout_s
        if deadline is not None:
            timeout_s = min(timeout_s, deadline.remaining())
        if timeout_s <= 0:
            raise LLMTimeoutError("request time budget exhausted")

        started = time.perf_counter()
        try:
            # The SDKs enforce `timeout_s` themselves; this is the safety net if one does not.
            async with asyncio.timeout(timeout_s + 1.0):
                raw = await slot.provider.generate(
                    messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    response_model=response_model,
                    images=images,
                    timeout_s=timeout_s,
                )
        except TimeoutError:
            error: LLMError = LLMTimeoutError()
            self._record_failure(
                slot, name, model, attempt, error, started, prompt_version, messages, images
            )
            raise error from None
        except LLMError as error:
            self._record_failure(
                slot, name, model, attempt, error, started, prompt_version, messages, images
            )
            raise

        slot.breaker.record_success()
        cost = self._pricing.cost_usd(model, raw.input_tokens, raw.output_tokens)
        self._report(
            LLMCallRecord(
                name=name,
                provider=slot.provider.name,
                model=model,
                attempt=attempt,
                ok=True,
                error_kind=None,
                input_tokens=raw.input_tokens,
                output_tokens=raw.output_tokens,
                latency_ms=raw.latency_ms,
                cost_usd=cost,
                prompt_version=prompt_version,
                messages=tuple(messages),
                images=tuple(images or ()),
                output_text=raw.text,
            )
        )
        return raw

    # ------------------------------------------------------------------ helpers

    def _record_failure(
        self,
        slot: ProviderSlot,
        name: str,
        model: str,
        attempt: int,
        error: LLMError,
        started: float,
        prompt_version: str | None,
        messages: list[Message],
        images: list[ImageInput] | None,
    ) -> None:
        if error.retryable:
            # Only transport-level trouble counts against the provider; a 400 is OUR mistake.
            slot.breaker.record_failure()
        self._report(
            LLMCallRecord(
                name=name,
                provider=slot.provider.name,
                model=model,
                attempt=attempt,
                ok=False,
                error_kind=error.kind,
                input_tokens=0,
                output_tokens=0,
                latency_ms=round((time.perf_counter() - started) * 1000),
                cost_usd=0.0,
                prompt_version=prompt_version,
                messages=tuple(messages),
                images=tuple(images or ()),
            )
        )

    def _report(self, record: LLMCallRecord) -> None:
        # Content (prompts, images, output) is never logged here: only the numbers.
        _logger.info(
            "llm_call",
            name=record.name,
            provider=record.provider,
            model=record.model,
            attempt=record.attempt,
            ok=record.ok,
            error_kind=record.error_kind,
            input_tokens=record.input_tokens,
            output_tokens=record.output_tokens,
            latency_ms=record.latency_ms,
            cost_usd=record.cost_usd,
        )
        if self._observer is not None:
            try:
                self._observer(record)
            except Exception:
                _logger.warning("llm_observer_failed")

    def _backoff(self, attempt: int, deadline: Deadline | None) -> float | None:
        """Equal-jitter exponential backoff, capped by what is left of the request budget."""
        exponential: float = min(self._max_backoff_s, self._base_backoff_s * 2 ** (attempt - 1))
        delay: float = exponential / 2 + self._rng() * exponential / 2
        if deadline is None:
            return delay
        room: float = deadline.remaining() - 0.5  # keep time for the next attempt itself
        if room <= 0:
            return None
        return min(delay, room)

    @staticmethod
    def _parse(text: str, response_model: type[BaseModel]) -> tuple[BaseModel | None, str]:
        try:
            return response_model.model_validate(json.loads(_strip_fences(text))), ""
        except json.JSONDecodeError:
            return None, "the answer was not valid JSON"
        except ValidationError as error:
            return None, _describe_validation_error(error)

    def _result(
        self,
        raw: RawResult,
        model: str,
        parsed: BaseModel | None,
        attempts: int,
        *,
        extra: RawResult | None,
    ) -> LLMResult:
        """Build the result; a repair call's tokens and cost are added to the first call's."""
        input_tokens = raw.input_tokens + (extra.input_tokens if extra else 0)
        output_tokens = raw.output_tokens + (extra.output_tokens if extra else 0)
        return LLMResult(
            text=raw.text if parsed is None else None,
            parsed=parsed,
            model=model,
            provider=raw.provider,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ms=raw.latency_ms + (extra.latency_ms if extra else 0),
            cost_usd=self._pricing.cost_usd(model, input_tokens, output_tokens),
            attempts=attempts,
        )
