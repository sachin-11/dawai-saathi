"""Sarvam AI speech-to-text adapter (`POST https://api.sarvam.ai/speech-to-text`, multipart).

From Sarvam's API reference (checked 2026-11-09, re-check before production):
  * auth header `api-subscription-key`
  * fields: `file`, `model` (`saaras:v4` default, `saaras:v3`), `language_code` (`hi-IN`, `en-IN`,
    or `unknown` for auto-detection), `mode` (`transcribe`, `translate`, `verbatim`, `translit`,
    `codemix`; documented for `saaras:v3` only)
  * accepts WAV, MP3, AAC, OGG, OPUS, FLAC, MP4/M4A, AMR, WebM ... (best at 16 kHz, mono)
  * the REST endpoint is meant for short clips ("under 30 seconds"): longer notes are skipped by the
    router (`STT_SARVAM_MAX_S`) and go to the other provider
  * the answer has `transcript`, `language_code` and (auto-detect only) `language_probability`

`language_probability` is the probability of the DETECTED LANGUAGE, not an ASR confidence, so it is
NOT reported as confidence: Sarvam results have `confidence = None`. Hinglish: pass `STT_SARVAM_MODE`
(for example `codemix` with `saaras:v3`) to keep English words in Latin script.
"""

import time
from typing import Final

import httpx

from app.llm.stt.http import post_multipart
from app.llm.stt.pricing import AudioPricing
from app.llm.stt.types import LanguageHint, STTResult
from app.llm.types import LLMBadRequestError

DEFAULT_URL: Final = "https://api.sarvam.ai/speech-to-text"
ACCEPTED: Final = frozenset(
    {
        "audio/ogg", "audio/opus", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr",
        "audio/wav", "audio/x-wav", "audio/flac", "audio/webm",
    }
)  # fmt: skip
_EXTENSIONS: Final = {
    "audio/ogg": "ogg", "audio/opus": "opus", "audio/mpeg": "mp3", "audio/mp4": "m4a",
    "audio/aac": "aac", "audio/amr": "amr", "audio/wav": "wav", "audio/x-wav": "wav",
    "audio/flac": "flac", "audio/webm": "webm",
}  # fmt: skip
_LANGUAGE_CODES: Final = {"hi": "hi-IN", "en": "en-IN", "auto": "unknown"}


class SarvamProvider:
    name = "sarvam"
    accepted_mimes = ACCEPTED

    def __init__(
        self,
        api_key: str,
        model: str | None,
        *,
        mode: str | None = None,
        max_duration_s: float | None = 30.0,
        url: str = DEFAULT_URL,
        pricing: AudioPricing | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self.model = model or "saaras"  # only a label for logs/pricing when the default is used
        self._send_model = model
        self._mode = mode
        self.max_duration_s = max_duration_s
        self._url = url
        self._pricing = pricing or AudioPricing({}, {})
        self._client = client

    async def transcribe(
        self, audio: bytes, mime: str, language_hint: LanguageHint, *, timeout_s: float
    ) -> STTResult:
        extension = _EXTENSIONS.get(mime)
        if extension is None:
            raise LLMBadRequestError("unsupported audio type for this provider")
        data = {"language_code": _LANGUAGE_CODES[language_hint]}
        if self._send_model:
            data["model"] = self._send_model
        if self._mode:
            data["mode"] = self._mode
        started = time.perf_counter()
        response = await post_multipart(
            self._client,
            self._url,
            headers={"api-subscription-key": self._api_key},
            data=data,
            files={"file": (f"voice.{extension}", audio, mime)},
            timeout_s=timeout_s,
        )
        latency_ms = round((time.perf_counter() - started) * 1000)
        try:
            body = response.json()
            text = str(body.get("transcript") or "").strip()
            code = body.get("language_code")
        except (ValueError, AttributeError):
            raise LLMBadRequestError("unreadable speech provider answer") from None
        duration_s = 0.0  # Sarvam does not report it: the router fills in the probed/decoded value
        return STTResult(
            text=text,
            language=code.split("-")[0].lower() if isinstance(code, str) and code else None,
            confidence=None,
            duration_s=duration_s,
            provider=self.name,
            model=self.model,
            latency_ms=latency_ms,
            cost_usd=0.0,
        )

    def price(self, duration_s: float) -> float:
        return self._pricing.stt_cost_usd(self.model, duration_s)
