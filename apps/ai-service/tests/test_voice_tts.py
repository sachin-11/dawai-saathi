"""M13: spoken replies: providers, router, the endpoint and the "what may be spoken" policy."""

import base64

import httpx
import pytest
from fastapi.testclient import TestClient

from app.llm.breaker import CircuitBreaker
from app.llm.stt.audio import Transcoder
from app.llm.stt.factory import build_tts_router
from app.llm.stt.pricing import AudioPricing
from app.llm.tts import (
    FakeTTS,
    OpenAITTS,
    SarvamTTS,
    SmallestTTS,
    SpeechTooLongError,
    TTSRouter,
    TTSSlot,
    fake_ogg_opus,
    fake_transcode_runner,
    wav_header_audio,
)
from app.llm.types import LLMBadRequestError, LLMServerError
from app.main import create_app
from tests.conftest import make_settings

TOKEN = "test-service-token"


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestAdapters:
    async def test_sarvam_request_and_response(self):
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["key"] = request.headers["api-subscription-key"]
            seen["json"] = request.read().decode()
            return httpx.Response(
                200, json={"audios": [base64.b64encode(wav_header_audio()).decode()]}
            )

        tts = SarvamTTS(
            "sv",
            "bulbul:v3",
            speaker_hi="shubh",
            pricing=AudioPricing.load(),
            client=_client(handler),
        )
        audio = await tts.synthesize("namaste", "hi", timeout_s=5)
        assert seen["key"] == "sv"
        body = str(seen["json"])
        assert '"language_code":"hi-IN"' in body.replace(" ", "")
        assert '"output_audio_codec":"wav"' in body.replace(" ", "")
        assert audio.data[:4] == b"RIFF" and audio.cost_usd == pytest.approx(0.02 * 7 / 1000)

    async def test_smallest_request_and_response(self):
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers["authorization"]
            seen["json"] = request.read().decode().replace(" ", "")
            return httpx.Response(200, content=wav_header_audio())

        tts = SmallestTTS(
            "sm", "lightning-v3.1", voice_hi="srishti", voice_en="lakshya", client=_client(handler)
        )
        audio = await tts.synthesize("namaste", "hi", timeout_s=5)
        assert seen["url"] == "https://api.smallest.ai/waves/v1/lightning-v3.1/get_speech"
        assert seen["auth"] == "Bearer sm"
        assert '"voice_id":"srishti"' in str(seen["json"])
        assert audio.data[:4] == b"RIFF" and audio.provider == "smallest"

    async def test_smallest_rejects_a_non_audio_answer(self):
        tts = SmallestTTS(
            "sm",
            "lightning-v3.1",
            voice_hi="a",
            voice_en="b",
            client=_client(lambda r: httpx.Response(200, content=b"<html>")),
        )
        with pytest.raises(LLMBadRequestError):
            await tts.synthesize("namaste", "en", timeout_s=5)

    async def test_sarvam_refuses_text_over_its_limit(self):
        tts = SarvamTTS("k", "bulbul:v3", client=_client(lambda r: httpx.Response(200)))
        with pytest.raises(SpeechTooLongError):
            await tts.synthesize("x" * 2501, "en", timeout_s=5)

    async def test_openai_request(self):
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["body"] = request.read().decode()
            return httpx.Response(200, content=wav_header_audio())

        tts = OpenAITTS("sk", "tts-1", "alloy", client=_client(handler))
        audio = await tts.synthesize("hello", "en", timeout_s=5)
        assert str(seen["url"]).endswith("/audio/speech")
        assert '"voice":"alloy"' in str(seen["body"]).replace(" ", "")
        assert audio.data[:4] == b"RIFF"


def _router(*providers, max_seconds: float = 45.0) -> TTSRouter:
    return TTSRouter(
        [TTSSlot(p, CircuitBreaker(2, 60)) for p in providers],
        call_timeout_s=5,
        transcoder=Transcoder(run=fake_transcode_runner),
        max_seconds=max_seconds,
    )


class _Failing(FakeTTS):
    name = "failing"

    async def synthesize(self, text, language, *, timeout_s):
        raise LLMServerError()


class TestRouter:
    async def test_output_is_ogg_opus_for_whatsapp(self):
        spoken = await _router(FakeTTS()).speak("namaste", "hi")
        assert spoken.mime == "audio/ogg" and spoken.data.startswith(b"OggS")

    async def test_falls_back_on_a_server_error(self):
        spoken = await _router(_Failing(), FakeTTS()).speak("hello", "en")
        assert spoken.provider == "fake"

    async def test_a_reply_that_would_take_too_long_is_refused(self):
        with pytest.raises(SpeechTooLongError):
            await _router(FakeTTS(), max_seconds=0.5).speak("hello", "en")

    async def test_the_real_transcode_command_makes_mono_opus_from_pipes(self):
        args = Transcoder().opus_args()
        assert args[args.index("-i") + 1] == "pipe:0" and "-ac" in args


class TestFactory:
    def test_off_by_default(self):
        assert build_tts_router(make_settings()) is None

    def test_on_in_fake_mode(self):
        assert build_tts_router(make_settings(tts_enabled=True)) is not None

    def test_a_real_provider_without_its_key_builds_nothing(self):
        settings = make_settings(TTS_ENABLED=True, LLM_MODE="real", TTS_PRIMARY="sarvam")
        assert build_tts_router(settings) is None


class TestSmallestFirstChain:
    def _settings(self, **extra):
        values = {
            "TTS_ENABLED": True,
            "LLM_MODE": "real",
            "TTS_PRIMARY": "smallest",
            "TTS_FALLBACK": "sarvam, openai",
            "SMALLEST_API_KEY": "sm",
            "TTS_MODEL_SMALLEST": "lightning-v3.1",
            "TTS_VOICE_SMALLEST_HI": "srishti",
            "TTS_VOICE_SMALLEST_EN": "lakshya",
            "SARVAM_API_KEY": "sv",
            "TTS_MODEL_SARVAM": "bulbul:v3",
            "OPENAI_API_KEY": "oa",
            "TTS_MODEL_OPENAI": "tts-1",
            "TTS_VOICE_OPENAI": "alloy",
        }
        values.update(extra)
        return make_settings(**values)

    def test_order_is_smallest_then_sarvam_then_openai(self):
        router = build_tts_router(self._settings())
        assert router is not None
        assert [slot.provider.name for slot in router._slots] == ["smallest", "sarvam", "openai"]

    def test_a_fallback_without_credentials_is_skipped(self):
        router = build_tts_router(self._settings(OPENAI_API_KEY=""))
        assert router is not None
        assert [slot.provider.name for slot in router._slots] == ["smallest", "sarvam"]


def _app(**settings):
    return create_app(make_settings(service_token=TOKEN, **settings))


class TestEndpoint:
    def test_disabled_tts_is_503_with_a_code(self):
        with TestClient(_app()) as client:
            response = client.post(
                "/v1/synthesize",
                headers={"X-Service-Token": TOKEN},
                json={"request_id": "r1", "language": "en", "text": "hello"},
            )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "TTS_NOT_ENABLED"

    def test_it_needs_the_service_token(self):
        with TestClient(_app(tts_enabled=True)) as client:
            response = client.post(
                "/v1/synthesize", json={"request_id": "r1", "language": "en", "text": "hello"}
            )
        assert response.status_code == 401

    def test_enabled_returns_an_ogg_voice_message(self):
        with TestClient(_app(tts_enabled=True)) as client:
            response = client.post(
                "/v1/synthesize",
                headers={"X-Service-Token": TOKEN},
                json={"request_id": "r1", "language": "hi", "text": "namaste"},
            )
        body = response.json()
        assert response.status_code == 200 and body["mime"] == "audio/ogg"
        assert base64.b64decode(body["audio_base64"]).startswith(b"OggS")

    def test_the_demo_token_is_not_accepted(self):
        settings = make_settings(service_token=TOKEN, tts_enabled=True, demo_service_token="d" * 20)
        with TestClient(create_app(settings)) as client:
            response = client.post(
                "/v1/synthesize",
                headers={"X-Service-Token": "d" * 20},
                json={"request_id": "r1", "language": "en", "text": "hello"},
            )
        assert response.status_code == 401


def test_fake_ogg_probe_roundtrip():
    from app.llm.stt.audio import probe_duration

    assert probe_duration(fake_ogg_opus(12.0), "audio/ogg") == pytest.approx(12.0, abs=0.01)
