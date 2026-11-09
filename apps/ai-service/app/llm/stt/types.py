"""Types of the speech layer (M13): what a speech-to-text provider takes and returns.

Audio is held in memory for ONE request and is never written to disk, logged or traced: anything
that describes it uses `describe_audio` ("[audio: 23 s, ogg]").
"""

from dataclasses import dataclass
from typing import Literal, Protocol

from app.llm.types import LLMError

LanguageHint = Literal["hi", "en", "auto"]


@dataclass(frozen=True, slots=True)
class STTSegment:
    start_s: float
    end_s: float
    text: str


@dataclass(frozen=True, slots=True)
class STTResult:
    """One transcript. `text` is exactly what the provider returned (Devanagari or Roman)."""

    text: str
    language: str | None  # "hi" | "en" | another ISO code | None when the provider did not say
    confidence: float | None  # 0..1, None when the provider gives no ASR confidence
    duration_s: float
    provider: str
    model: str
    latency_ms: int
    cost_usd: float = 0.0
    segments: tuple[STTSegment, ...] | None = None
    fallback_used: bool = False


class AudioUnreadableError(LLMError):
    """The audio itself cannot be decoded (corrupt, empty, not audio). Another provider will not help."""

    kind = "audio_unreadable"


class STTProvider(Protocol):
    name: str
    model: str
    # mime types (without parameters) the provider takes as they are; others are transcoded to WAV
    accepted_mimes: frozenset[str]
    # a provider that is meant for short clips only; the router skips it for a longer note
    max_duration_s: float | None

    async def transcribe(
        self, audio: bytes, mime: str, language_hint: LanguageHint, *, timeout_s: float
    ) -> STTResult:
        """Return the transcript. Raises `LLMError` subclasses (the router decides retry/fallback)."""
        ...

    def price(self, duration_s: float) -> float:
        """Dollar cost of `duration_s` seconds of audio."""
        ...


def describe_audio(duration_s: float | None, mime: str) -> str:
    """What traces and logs show instead of the audio itself."""
    kind = mime.split(";", 1)[0].strip().split("/")[-1] or "audio"
    seconds = f"{round(duration_s)} s" if duration_s is not None else "? s"
    return f"[audio: {seconds}, {kind}]"
