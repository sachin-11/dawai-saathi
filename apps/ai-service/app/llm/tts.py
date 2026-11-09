"""Text-to-speech (M13, optional, OFF by default).

  TTSProvider      protocol: `synthesize(text, language) -> TTSAudio` (WAV or MP3 bytes from the vendor)
  SarvamTTS        `POST https://api.sarvam.ai/text-to-speech` (JSON; answer `audios[]` = base64 WAV).
                   Checked against Sarvam's reference 2026-11-09: fields `text`, `language_code`
                   (`hi-IN`/`en-IN`), `speaker`, `model` (`bulbul:v3`, `bulbul:v4-flash`),
                   `output_audio_codec` (wav/mp3/aac/flac/linear16; `opus` is rejected, no OGG),
                   text limit 2500 characters (v3 / v4-flash)
  SmallestTTS      `POST https://api.smallest.ai/waves/v1/{model}/get_speech` (JSON `text`, `voice_id`,
                   `sample_rate`, `output_format`; binary WAV answer). Checked by a live call on
                   2026-11-09 with model `lightning-v3.1` (v2 is retired, HTTP 410); the character
                   limit is NOT known, `SMALLEST_MAX_CHARS` is a conservative guess
  OpenAITTS        `POST {base}/audio/speech` (JSON `model`, `input`, `voice`, `response_format`;
                   binary answer). NOT re-verified against OpenAI's current reference (its docs site
                   blocked automated reading): check model and voice names before production
  FakeTTS          deterministic, no network
  TTSRouter        primary then fallback (timeouts/429/5xx/connection only), breaker per provider

WhatsApp wants Ogg/Opus: whatever the vendor returns is converted IN MEMORY by `Transcoder` (pipes,
no temp files). The text reply is always sent as well; this module only makes the extra audio.
"""

import base64
import struct
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal, Protocol

import httpx
import structlog

from app.llm.breaker import CircuitBreaker
from app.llm.stt.audio import Transcoder, probe_duration
from app.llm.stt.http import post_json
from app.llm.stt.pricing import AudioPricing
from app.llm.types import (
    LLMBadRequestError,
    LLMConfigError,
    LLMError,
    LLMUnavailableError,
)
from app.observability.metrics import METRICS

_log = structlog.get_logger("tts")

TTSLanguage = Literal["hi", "en"]
MAX_SPOKEN_SECONDS: Final = 45.0
SARVAM_URL: Final = "https://api.sarvam.ai/text-to-speech"
SARVAM_MAX_CHARS: Final = 2500
SMALLEST_URL: Final = "https://api.smallest.ai/waves/v1"
SMALLEST_MAX_CHARS: Final = 1000


class SpeechTooLongError(LLMError):
    kind = "speech_too_long"


@dataclass(frozen=True, slots=True)
class TTSAudio:
    data: bytes
    mime: str  # the vendor's format, e.g. "audio/wav"
    provider: str
    model: str
    characters: int
    latency_ms: int
    cost_usd: float


@dataclass(frozen=True, slots=True)
class SpokenReply:
    """Ogg/Opus ready for WhatsApp, plus what the request cost."""

    data: bytes
    mime: str
    duration_s: float
    provider: str
    model: str
    cost_usd: float


class TTSProvider(Protocol):
    name: str
    model: str

    async def synthesize(
        self, text: str, language: TTSLanguage, *, timeout_s: float
    ) -> TTSAudio: ...


def wav_header_audio(duration_s: float = 1.0, rate: int = 16000) -> bytes:
    """A silent mono 16-bit WAV (used by the fake provider and tests)."""
    pcm = b"\x00\x00" * int(rate * duration_s)
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
    header += struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    return header + b"data" + struct.pack("<I", len(pcm)) + pcm


class FakeTTS:
    name = "fake"
    model = "fake-tts"

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []  # lengths only, never the text

    async def synthesize(self, text: str, language: TTSLanguage, *, timeout_s: float) -> TTSAudio:
        self.calls.append({"characters": len(text), "language": language})
        return TTSAudio(wav_header_audio(), "audio/wav", self.name, self.model, len(text), 1, 0.0)


class SarvamTTS:
    name = "sarvam"
    _CODES: Final = {"hi": "hi-IN", "en": "en-IN"}

    def __init__(
        self,
        api_key: str,
        model: str,
        *,
        speaker_hi: str | None = None,
        speaker_en: str | None = None,
        pricing: AudioPricing | None = None,
        client: httpx.AsyncClient | None = None,
        url: str = SARVAM_URL,
    ) -> None:
        self._api_key = api_key
        self.model = model
        self._speakers = {"hi": speaker_hi, "en": speaker_en}
        self._pricing = pricing or AudioPricing({}, {})
        self._client = client
        self._url = url

    async def synthesize(self, text: str, language: TTSLanguage, *, timeout_s: float) -> TTSAudio:
        if len(text) > SARVAM_MAX_CHARS:
            raise SpeechTooLongError("text is longer than the provider accepts")
        body: dict[str, object] = {
            "text": text,
            "language_code": self._CODES[language],
            "model": self.model,
            "output_audio_codec": "wav",
        }
        speaker = self._speakers[language]
        if speaker:
            body["speaker"] = speaker
        started = time.perf_counter()
        response = await post_json(
            self._client,
            self._url,
            headers={"api-subscription-key": self._api_key},
            body=body,
            timeout_s=timeout_s,
        )
        try:
            audio = base64.b64decode(response.json()["audios"][0], validate=False)
        except (ValueError, KeyError, IndexError, TypeError):
            raise LLMBadRequestError("unreadable speech provider answer") from None
        return TTSAudio(
            audio,
            "audio/wav",
            self.name,
            self.model,
            len(text),
            round((time.perf_counter() - started) * 1000),
            self._pricing.tts_cost_usd(self.model, len(text)),
        )


class SmallestTTS:
    name = "smallest"

    def __init__(
        self,
        api_key: str,
        model: str,
        *,
        voice_hi: str,
        voice_en: str,
        pricing: AudioPricing | None = None,
        client: httpx.AsyncClient | None = None,
        base_url: str = SMALLEST_URL,
    ) -> None:
        self._api_key = api_key
        self.model = model
        self._voices = {"hi": voice_hi, "en": voice_en}
        self._pricing = pricing or AudioPricing({}, {})
        self._client = client
        self._url = f"{base_url.rstrip('/')}/{model}/get_speech"

    async def synthesize(self, text: str, language: TTSLanguage, *, timeout_s: float) -> TTSAudio:
        if len(text) > SMALLEST_MAX_CHARS:
            raise SpeechTooLongError("text is longer than the provider accepts")
        started = time.perf_counter()
        response = await post_json(
            self._client,
            self._url,
            headers={"Authorization": f"Bearer {self._api_key}"},
            body={
                "text": text,
                "voice_id": self._voices[language],
                "sample_rate": 24000,
                "output_format": "wav",
            },
            timeout_s=timeout_s,
        )
        if not response.content.startswith(b"RIFF"):
            raise LLMBadRequestError("unreadable speech provider answer")
        return TTSAudio(
            response.content,
            "audio/wav",
            self.name,
            self.model,
            len(text),
            round((time.perf_counter() - started) * 1000),
            self._pricing.tts_cost_usd(self.model, len(text)),
        )


class OpenAITTS:
    name = "openai"

    def __init__(
        self,
        api_key: str,
        model: str,
        voice: str,
        *,
        base_url: str = "https://api.openai.com/v1",
        pricing: AudioPricing | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self.model = model
        self._voice = voice
        self._url = f"{base_url.rstrip('/')}/audio/speech"
        self._pricing = pricing or AudioPricing({}, {})
        self._client = client

    async def synthesize(self, text: str, language: TTSLanguage, *, timeout_s: float) -> TTSAudio:
        started = time.perf_counter()
        response = await post_json(
            self._client,
            self._url,
            headers={"Authorization": f"Bearer {self._api_key}"},
            body={
                "model": self.model,
                "voice": self._voice,
                "input": text,
                "response_format": "wav",
            },
            timeout_s=timeout_s,
        )
        return TTSAudio(
            response.content,
            "audio/wav",
            self.name,
            self.model,
            len(text),
            round((time.perf_counter() - started) * 1000),
            self._pricing.tts_cost_usd(self.model, len(text)),
        )


@dataclass(slots=True)
class TTSSlot:
    provider: TTSProvider
    breaker: CircuitBreaker


class TTSRouter:
    def __init__(
        self,
        slots: Sequence[TTSSlot],
        *,
        call_timeout_s: float,
        transcoder: Transcoder | None = None,
        max_seconds: float = MAX_SPOKEN_SECONDS,
    ) -> None:
        if not slots:
            raise LLMConfigError("at least one speech provider is required")
        self._slots = list(slots)
        self._timeout_s = call_timeout_s
        self._transcoder = transcoder or Transcoder()
        self._max_seconds = max_seconds

    async def speak(self, text: str, language: TTSLanguage) -> SpokenReply:
        last: LLMError | None = None
        for slot in self._slots:
            if not slot.breaker.allow():
                continue
            try:
                audio = await slot.provider.synthesize(text, language, timeout_s=self._timeout_s)
            except LLMError as error:
                if not error.fallback_ok:
                    raise
                slot.breaker.record_failure()
                last = error
                _log.warning("tts_provider_failed", provider=slot.provider.name, kind=error.kind)
                continue
            slot.breaker.record_success()
            ogg = await self._transcoder.to_ogg_opus(audio.data)
            duration = probe_duration(ogg, "audio/ogg") or 0.0
            if duration > self._max_seconds:
                raise SpeechTooLongError("the spoken reply would be too long")
            METRICS.count_tts_sent(audio.provider)
            return SpokenReply(
                ogg, "audio/ogg", duration, audio.provider, audio.model, audio.cost_usd
            )
        raise LLMUnavailableError("no speech provider could synthesise") from last


def fake_ogg_opus(duration_s: float = 2.0) -> bytes:
    """A tiny Ogg page whose granule position says `duration_s` (what `probe_duration` reads).
    NOT playable audio: only for the fake mode and tests, where ffmpeg is not needed."""
    granule = int(duration_s * 48_000)
    return b"OggS" + struct.pack("<BBqIIIB", 0, 4, granule, 1, 0, 0, 0)


async def fake_transcode_runner(args: list[str], stdin: bytes) -> tuple[int, bytes, bytes]:
    """Stands in for ffmpeg when LLM_MODE=fake: the conversion returns the fake page."""
    return 0, fake_ogg_opus(max(1.0, len(stdin) / 32000)), b""
