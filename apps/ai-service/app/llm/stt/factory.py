"""Build the speech routers from settings: real providers (Whisper, Sarvam), or the offline fakes."""

from app.config import Settings, SttProviderName
from app.llm.breaker import CircuitBreaker
from app.llm.stt.audio import Transcoder
from app.llm.stt.fake import FakeSTTProvider
from app.llm.stt.pricing import AudioPricing
from app.llm.stt.router import STTRouter, STTSlot
from app.llm.stt.sarvam import SarvamProvider
from app.llm.stt.types import STTProvider
from app.llm.stt.whisper import WhisperProvider
from app.llm.tts import (
    FakeTTS,
    OpenAITTS,
    SarvamTTS,
    TTSProvider,
    TTSRouter,
    TTSSlot,
    fake_transcode_runner,
)
from app.llm.types import LLMConfigError


def _breaker(settings: Settings) -> CircuitBreaker:
    return CircuitBreaker(settings.llm_breaker_threshold, settings.llm_breaker_cooldown_s)


def _stt_provider(name: SttProviderName, settings: Settings, pricing: AudioPricing) -> STTProvider:
    if name == "whisper":
        key = settings.openai_api_key
        if key is None or settings.stt_model_whisper is None:
            raise LLMConfigError("OPENAI_API_KEY and STT_MODEL_WHISPER are required for whisper")
        return WhisperProvider(
            key.get_secret_value(),
            settings.stt_model_whisper,
            base_url=settings.openai_base_url,
            pricing=pricing,
        )
    sarvam_key = settings.sarvam_api_key
    if sarvam_key is None:
        raise LLMConfigError("SARVAM_API_KEY is required for sarvam")
    return SarvamProvider(
        sarvam_key.get_secret_value(),
        settings.stt_model_sarvam,
        mode=settings.stt_sarvam_mode,
        max_duration_s=settings.stt_sarvam_max_s or None,
        pricing=pricing,
    )


def build_stt_router(
    settings: Settings,
    *,
    fake_provider: FakeSTTProvider | None = None,
    pricing: AudioPricing | None = None,
    transcoder: Transcoder | None = None,
) -> STTRouter | None:
    """`None` when no provider is configured: voice notes then get the honest "type it" reply."""
    pricing = pricing or AudioPricing.load()
    if settings.llm_mode == "fake":
        slots = [STTSlot(fake_provider or FakeSTTProvider(), _breaker(settings))]
    else:
        names = [n for n in (settings.stt_primary, settings.stt_fallback) if n is not None]
        if not names:
            return None
        slots = [STTSlot(_stt_provider(n, settings, pricing), _breaker(settings)) for n in names]
    return STTRouter(
        slots,
        call_timeout_s=settings.stt_call_timeout_s,
        max_attempts=settings.llm_max_attempts,
        transcoder=transcoder or Transcoder(ffmpeg_path=settings.ffmpeg_path),
    )


def build_tts_router(
    settings: Settings,
    *,
    fake_provider: TTSProvider | None = None,
    pricing: AudioPricing | None = None,
) -> TTSRouter | None:
    """`None` unless TTS is switched on and a provider is configured."""
    if not settings.tts_enabled:
        return None
    pricing = pricing or AudioPricing.load()
    if settings.llm_mode == "fake":
        return TTSRouter(
            [TTSSlot(fake_provider or FakeTTS(), _breaker(settings))],
            call_timeout_s=settings.tts_call_timeout_s,
            transcoder=Transcoder(run=fake_transcode_runner),
        )
    slots: list[TTSSlot] = []
    for name in (settings.tts_primary, settings.tts_fallback):
        if name == "sarvam" and settings.sarvam_api_key and settings.tts_model_sarvam:
            slots.append(
                TTSSlot(
                    SarvamTTS(
                        settings.sarvam_api_key.get_secret_value(),
                        settings.tts_model_sarvam,
                        speaker_hi=settings.tts_speaker_hi,
                        speaker_en=settings.tts_speaker_en,
                        pricing=pricing,
                    ),
                    _breaker(settings),
                )
            )
        elif (
            name == "openai"
            and settings.openai_api_key
            and settings.tts_model_openai
            and settings.tts_voice_openai
        ):
            slots.append(
                TTSSlot(
                    OpenAITTS(
                        settings.openai_api_key.get_secret_value(),
                        settings.tts_model_openai,
                        settings.tts_voice_openai,
                        base_url=settings.openai_base_url,
                        pricing=pricing,
                    ),
                    _breaker(settings),
                )
            )
    if not slots:
        return None
    return TTSRouter(
        slots,
        call_timeout_s=settings.tts_call_timeout_s,
        transcoder=Transcoder(ffmpeg_path=settings.ffmpeg_path),
    )
