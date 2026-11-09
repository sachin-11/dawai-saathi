"""Offline speech provider for tests, CI and `LLM_MODE=fake` (M13).

Fixture-driven: the "audio" is bytes of the form `FAKEAUDIO\\n{json}` where the JSON carries what the
provider should "hear" (`text`, optional `language`, `confidence`, `duration_s`). `make_fake_audio`
builds it. Real audio bytes are refused, so a fake run can never pretend to have heard something.
A scripted list of results/errors lets a test drive retries and fallbacks.
"""

import json
from collections.abc import Sequence

from app.llm.stt.audio import FAKE_AUDIO_MAGIC
from app.llm.stt.types import AudioUnreadableError, LanguageHint, STTResult
from app.llm.types import LLMError

FAKE_STT_MODEL = "fake-stt"


def make_fake_audio(
    text: str,
    *,
    language: str | None = None,
    confidence: float | None = 0.95,
    duration_s: float = 4.0,
) -> bytes:
    payload = {
        "text": text,
        "language": language,
        "confidence": confidence,
        "duration_s": duration_s,
    }
    return FAKE_AUDIO_MAGIC + json.dumps(payload, ensure_ascii=False).encode("utf-8")


class FakeSTTProvider:
    name = "fake"
    model = FAKE_STT_MODEL
    max_duration_s: float | None = None
    accepted_mimes = frozenset(
        {"audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "audio/wav"}
    )

    def __init__(self, script: Sequence[STTResult | LLMError] | None = None) -> None:
        self._script = list(script or [])
        self.calls: list[dict[str, object]] = []  # sizes and hints only: never the audio

    async def transcribe(
        self, audio: bytes, mime: str, language_hint: LanguageHint, *, timeout_s: float
    ) -> STTResult:
        self.calls.append({"mime": mime, "bytes": len(audio), "hint": language_hint})
        if self._script:
            step = self._script.pop(0)
            if isinstance(step, LLMError):
                raise step
            return step
        if not audio.startswith(FAKE_AUDIO_MAGIC):
            raise AudioUnreadableError("the fake provider only understands fake audio")
        try:
            payload = json.loads(audio[len(FAKE_AUDIO_MAGIC) :].decode("utf-8"))
            return STTResult(
                text=str(payload["text"]),
                language=payload.get("language"),
                confidence=payload.get("confidence"),
                duration_s=float(payload.get("duration_s", 4.0)),
                provider=self.name,
                model=self.model,
                latency_ms=1,
            )
        except (ValueError, KeyError, TypeError):
            raise AudioUnreadableError("malformed fake audio") from None

    def price(self, duration_s: float) -> float:
        return 0.0
