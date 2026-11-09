"""`STTRouter`: primary speech provider, then the fallback (M13). The same rules as the LLM router
(M5), applied to audio:

  * retry inside a provider with exponential backoff + jitter, within the request deadline
  * fall back to the other provider ONLY on timeout / 429 / 5xx / connection errors; never on a bad
    request, bad credentials or an undecodable file (another provider will not fix those)
  * a provider with an open circuit breaker is skipped
  * a provider that only suits short clips (Sarvam REST) is skipped for a longer note
  * a provider that does not take the file's format gets a 16 kHz WAV made IN MEMORY by ffmpeg
  * the cost of every call is computed from `pricing.yaml`; metrics are counted here

Audio bytes never reach a log, a trace or an exception message.
"""

import asyncio
import random
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace

import structlog

from app.llm.breaker import CircuitBreaker
from app.llm.router import Deadline
from app.llm.stt.audio import Transcoder, normalise_audio_mime, probe_duration
from app.llm.stt.types import LanguageHint, STTProvider, STTResult
from app.llm.types import LLMConfigError, LLMError, LLMTimeoutError, LLMUnavailableError
from app.observability.metrics import METRICS

_log = structlog.get_logger("stt")

Sleep = Callable[[float], Awaitable[None]]
WAV_MIME = "audio/wav"


@dataclass(slots=True)
class STTSlot:
    provider: STTProvider
    breaker: CircuitBreaker


class STTRouter:
    def __init__(
        self,
        slots: Sequence[STTSlot],
        *,
        call_timeout_s: float,
        max_attempts: int,
        transcoder: Transcoder | None = None,
        sleep: Sleep = asyncio.sleep,
        rng: Callable[[], float] = random.random,
        base_backoff_s: float = 0.5,
        max_backoff_s: float = 4.0,
    ) -> None:
        if not slots:
            raise LLMConfigError("at least one speech provider is required")
        self._slots = list(slots)
        self._call_timeout_s = call_timeout_s
        self._max_attempts = max_attempts
        self._transcoder = transcoder or Transcoder()
        self._sleep = sleep
        self._rng = rng
        self._base_backoff_s = base_backoff_s
        self._max_backoff_s = max_backoff_s

    @property
    def provider_names(self) -> list[str]:
        return [slot.provider.name for slot in self._slots]

    async def transcribe(
        self,
        audio: bytes,
        mime: str,
        language_hint: LanguageHint,
        *,
        deadline: Deadline | None = None,
    ) -> STTResult:
        mime = normalise_audio_mime(mime)
        probed = probe_duration(audio, mime)
        wav: tuple[bytes, float] | None = None  # converted at most once per request
        last_error: LLMError | None = None

        for index, slot in enumerate(self._slots):
            provider = slot.provider
            if probed and provider.max_duration_s and probed > provider.max_duration_s:
                _log.info("stt_provider_skipped_long_audio", provider=provider.name)
                continue
            if not slot.breaker.allow():
                _log.warning("stt_provider_skipped_breaker_open", provider=provider.name)
                continue
            try:
                payload, payload_mime = audio, mime
                if mime not in provider.accepted_mimes:
                    if wav is None:
                        wav = await self._transcoder.to_wav(audio)
                    payload, payload_mime = wav[0], WAV_MIME
                result = await self._with_retries(
                    slot, payload, payload_mime, language_hint, deadline
                )
            except LLMError as error:
                if not error.fallback_ok:
                    raise  # unreadable audio, bad credentials ...: another provider will not help
                last_error = error
                _log.warning(
                    "stt_provider_failed",
                    provider=provider.name,
                    error_kind=error.kind,
                    will_fall_back=index < len(self._slots) - 1,
                )
                continue

            duration = result.duration_s or (wav[1] if wav else 0.0) or probed or 0.0
            result = replace(
                result,
                duration_s=duration,
                cost_usd=provider.price(duration) if duration else result.cost_usd,
                fallback_used=index > 0,
            )
            METRICS.observe_stt(provider.name, result.latency_ms, fallback=index > 0)
            return result

        raise LLMUnavailableError("no speech provider could transcribe") from last_error

    async def _with_retries(
        self,
        slot: STTSlot,
        audio: bytes,
        mime: str,
        hint: LanguageHint,
        deadline: Deadline | None,
    ) -> STTResult:
        last: LLMError | None = None
        for attempt in range(1, self._max_attempts + 1):
            timeout = self._call_timeout_s
            if deadline is not None:
                timeout = min(timeout, deadline.remaining())
            if timeout <= 0:
                slot.breaker.record_failure()
                raise LLMTimeoutError("no time left for speech-to-text")
            started = time.perf_counter()
            try:
                async with asyncio.timeout(timeout + 1):
                    result = await slot.provider.transcribe(audio, mime, hint, timeout_s=timeout)
            except TimeoutError:
                last = LLMTimeoutError("speech provider timed out")
            except LLMError as error:
                if not error.retryable:
                    # the provider answered, so it is alive: only transport trouble trips the breaker
                    if error.fallback_ok:
                        slot.breaker.record_failure()
                    raise
                last = error
            else:
                slot.breaker.record_success()
                return result
            _log.warning(
                "stt_attempt_failed",
                provider=slot.provider.name,
                attempt=attempt,
                error_kind=last.kind,
                latency_ms=round((time.perf_counter() - started) * 1000),
            )
            if attempt < self._max_attempts:
                delay = min(self._max_backoff_s, self._base_backoff_s * 2 ** (attempt - 1))
                await self._sleep(delay * (0.5 + self._rng() / 2))
        slot.breaker.record_failure()
        assert last is not None  # noqa: S101 - the loop ran at least once
        raise last
