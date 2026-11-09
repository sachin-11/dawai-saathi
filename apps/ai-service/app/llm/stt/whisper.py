"""OpenAI transcription adapter (`POST {base}/audio/transcriptions`, multipart).

Request: `file`, `model`, `response_format`, and `language` (ISO-639-1) when the user's language is
known. For `whisper-*` models the answer is requested as `verbose_json`, which carries the duration,
the detected language and per-segment `avg_logprob` / `no_speech_prob`; other models (the
gpt-4o-transcribe family) answer plain `json` with the text only, so there is no confidence.

Confidence (only when segments are present):
    exp(mean avg_logprob) * (1 - mean no_speech_prob)      # 0..1; near 0 for noise/silence

Model id, endpoint and price are configuration (`STT_MODEL_WHISPER`, `OPENAI_BASE_URL`,
`pricing.yaml`), never constants. Formats OpenAI accepts and the upload size limit must be checked
against the provider's CURRENT docs before production (the list below is the conservative subset we
rely on; everything else is converted to 16 kHz WAV first).
"""

import math
import time
from typing import Any, Final

import httpx

from app.llm.stt.http import post_multipart
from app.llm.stt.pricing import AudioPricing
from app.llm.stt.types import LanguageHint, STTResult, STTSegment
from app.llm.types import LLMBadRequestError

DEFAULT_BASE_URL: Final = "https://api.openai.com/v1"
ACCEPTED: Final = frozenset(
    {"audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/flac", "audio/webm"}
)
_EXTENSIONS: Final = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/webm": "webm",
}


def confidence_from_segments(segments: list[dict[str, Any]]) -> float | None:
    logprobs = [
        s["avg_logprob"] for s in segments if isinstance(s.get("avg_logprob"), (int, float))
    ]
    if not logprobs:
        return None
    no_speech = [
        float(s["no_speech_prob"])
        for s in segments
        if isinstance(s.get("no_speech_prob"), (int, float))
    ]
    value = math.exp(sum(logprobs) / len(logprobs))
    if no_speech:
        value *= 1.0 - min(1.0, sum(no_speech) / len(no_speech))
    return max(0.0, min(1.0, value))


class WhisperProvider:
    name = "whisper"
    max_duration_s: float | None = None
    accepted_mimes = ACCEPTED

    def __init__(
        self,
        api_key: str,
        model: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        pricing: AudioPricing | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self.model = model
        self._url = f"{base_url.rstrip('/')}/audio/transcriptions"
        self._pricing = pricing or AudioPricing({}, {})
        self._client = client

    async def transcribe(
        self, audio: bytes, mime: str, language_hint: LanguageHint, *, timeout_s: float
    ) -> STTResult:
        extension = _EXTENSIONS.get(mime)
        if extension is None:
            raise LLMBadRequestError("unsupported audio type for this provider")
        verbose = self.model.startswith("whisper")
        data = {"model": self.model, "response_format": "verbose_json" if verbose else "json"}
        if language_hint != "auto":
            data["language"] = language_hint
        started = time.perf_counter()
        response = await post_multipart(
            self._client,
            self._url,
            headers={"Authorization": f"Bearer {self._api_key}"},
            data=data,
            files={"file": (f"voice.{extension}", audio, mime)},
            timeout_s=timeout_s,
        )
        latency_ms = round((time.perf_counter() - started) * 1000)
        try:
            body = response.json()
            text = str(body.get("text") or "").strip()
        except (ValueError, AttributeError):
            raise LLMBadRequestError("unreadable speech provider answer") from None

        raw_segments = body.get("segments") if isinstance(body.get("segments"), list) else []
        segments = tuple(
            STTSegment(float(s.get("start", 0.0)), float(s.get("end", 0.0)), str(s.get("text", "")))
            for s in raw_segments
            if isinstance(s, dict)
        )
        duration_s = float(body.get("duration") or (segments[-1].end_s if segments else 0.0))
        return STTResult(
            text=text,
            language=_iso(body.get("language")),
            confidence=confidence_from_segments(raw_segments) if raw_segments else None,
            duration_s=duration_s,
            provider=self.name,
            model=self.model,
            latency_ms=latency_ms,
            cost_usd=self.price(duration_s),
            segments=segments or None,
        )

    def price(self, duration_s: float) -> float:
        return self._pricing.stt_cost_usd(self.model, duration_s)


_LANGUAGE_NAMES: Final = {"hindi": "hi", "english": "en"}


def _iso(value: object) -> str | None:
    """Whisper reports a language NAME ("hindi"); normalise to an ISO code."""
    if not isinstance(value, str) or not value:
        return None
    lowered = value.lower()
    return _LANGUAGE_NAMES.get(lowered, lowered[:2] if len(lowered) > 3 else lowered)
