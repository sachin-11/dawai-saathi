"""M13: the speech layer: transliteration, command table, probes, adapters, transcoder, router."""

import asyncio
import json
import struct
import tempfile
from pathlib import Path

import httpx
import pytest

from app.llm.breaker import CircuitBreaker
from app.llm.router import Deadline
from app.llm.stt.audio import (
    FAKE_AUDIO_MAGIC,
    Transcoder,
    TranscodeUnavailableError,
    pcm_to_wav,
    probe_duration,
)
from app.llm.stt.fake import FakeSTTProvider, make_fake_audio
from app.llm.stt.pricing import AudioPricing
from app.llm.stt.router import STTRouter, STTSlot
from app.llm.stt.sarvam import SarvamProvider
from app.llm.stt.types import AudioUnreadableError, STTResult, describe_audio
from app.llm.stt.whisper import WhisperProvider, confidence_from_segments
from app.llm.tts import fake_ogg_opus
from app.llm.types import (
    LLMAuthError,
    LLMRateLimitError,
    LLMServerError,
    LLMUnavailableError,
)
from app.safety.commands import load_command_table, normalise_for_matching
from app.safety.translit import has_devanagari, to_roman
from app.schemas.process import Command

ROOT = Path(__file__).parents[3]


# ---------------------------------------------------------------------------- transliteration


class TestTransliteration:
    @pytest.mark.parametrize(
        ("devanagari", "roman"),
        [
            ("सीने में दर्द", "seene men dard"),
            ("डोलो 650 का जेनेरिक बताओ", "dolo 650 kaa jenerik bataao"),
            ("साँस नहीं आ रही", "saans naheen aa rahee"),
            ("९८७६५", "98765"),
        ],
    )
    def test_known_phrases(self, devanagari, roman):
        assert to_roman(devanagari) == roman

    def test_latin_text_is_untouched(self):
        assert to_roman("Dolo 650 ka generic batao") == "Dolo 650 ka generic batao"
        assert not has_devanagari("Dolo 650")

    def test_mixed_script(self):
        assert to_roman("Dolo 650 का generic") == "Dolo 650 kaa generic"

    def test_the_roman_copy_matches_the_emergency_rules(self):
        """The point of the copy: Roman keyword rules fire on a Devanagari transcript."""
        from app.safety.emergency_guard import EmergencyGuard, UserText

        guard = EmergencyGuard()
        assert guard.check_rules(UserText(to_roman("सीने में दर्द हो रहा है"))).is_emergency


# ---------------------------------------------------------------------------- commands


class TestCommandTable:
    table = load_command_table()

    @pytest.mark.parametrize(
        ("spoken", "command"),
        [
            ("Meds dikhao.", Command.meds),
            ("meri dawai", Command.meds),
            ("मेरी दवाइयां", Command.meds),
            ("Please, reminder band karo!", Command.stop_reminders),
            ("reminder chalu karo ji", Command.start_reminders),
            ("help", Command.help),
            ("delete my data", Command.delete),
            ("le li", Command.reminder_taken),
            ("Maine dawai le li", Command.reminder_taken),
            ("baad me", Command.reminder_snooze),
            ("awaaz me jawab do", Command.voice_on),
            ("voice off", Command.voice_off),
        ],
    )
    def test_whole_utterance_commands(self, spoken, command):
        assert self.table.detect(spoken) is command

    @pytest.mark.parametrize(
        "spoken",
        [
            "mujhe apni dawai ke baare me poochna hai",
            "please delete this from my prescription",
            "Dolo 650 kab leni hai",
            "help me with my medicine",
            "",
        ],
    )
    def test_a_sentence_that_merely_contains_a_command_word_is_not_a_command(self, spoken):
        assert self.table.detect(spoken) is None

    @pytest.mark.parametrize("spoken", ["haan", "ha", "nahi", "caregiver", "parivar jodo"])
    def test_bare_yes_no_and_caregiver_are_never_voice_commands(self, spoken):
        assert self.table.detect(spoken) is None

    def test_the_original_script_or_the_roman_copy_can_match(self):
        assert self.table.detect("zzz", "meds dikhao") is Command.meds

    def test_normalisation_matches_the_gateway_vectors(self):
        assert normalise_for_matching("  HELP!! 🙏 ") == "help"

    def test_the_copy_is_identical_to_the_canonical_file(self):
        canonical = (ROOT / "packages/contracts/commands/aliases.json").read_text(encoding="utf-8")
        copy = (Path(__file__).parents[1] / "app/safety/data/command-aliases.json").read_text(
            encoding="utf-8"
        )
        assert copy == canonical, "run `make safety-data`"

    def test_every_voice_command_is_a_known_contract_command(self):
        data = json.loads(
            (ROOT / "packages/contracts/commands/aliases.json").read_text(encoding="utf-8")
        )
        assert {c.value for c in Command} >= set(data["voice_commands"])
        assert "caregiver_add" not in data["voice_commands"]


# ---------------------------------------------------------------------------- probe


class TestProbe:
    def test_ogg_opus_duration_from_the_last_page(self):
        assert probe_duration(fake_ogg_opus(23.0), "audio/ogg") == pytest.approx(23.0, abs=0.01)

    def test_fake_audio_carries_its_duration(self):
        assert probe_duration(make_fake_audio("hi", duration_s=7.5), "audio/ogg") == 7.5

    def test_unknown_containers_have_no_probe(self):
        assert probe_duration(b"\x00\x01\x02", "audio/amr") is None
        assert probe_duration(b"", "audio/ogg") is None

    def test_description_never_contains_audio_or_text(self):
        assert describe_audio(23.2, "audio/ogg; codecs=opus") == "[audio: 23 s, ogg]"


# ---------------------------------------------------------------------------- transcoder


class TestTranscoder:
    async def test_ffmpeg_is_driven_through_pipes_only_and_no_temp_file_is_made(self, monkeypatch):
        seen: dict[str, object] = {}

        async def run(args, stdin):
            seen["args"] = args
            seen["stdin"] = stdin
            return 0, b"\x01\x00" * 16000, b""  # one second of 16 kHz PCM

        def forbidden(*_a, **_k):
            raise AssertionError("audio must never be written to disk")

        monkeypatch.setattr(tempfile, "NamedTemporaryFile", forbidden)
        monkeypatch.setattr(tempfile, "mkstemp", forbidden)
        monkeypatch.setattr(tempfile, "TemporaryDirectory", forbidden)

        wav, duration = await Transcoder(run=run).to_wav(b"opaque-amr-bytes")
        args = seen["args"]
        assert args[args.index("-i") + 1] == "pipe:0" and args[-1] == "pipe:1"
        assert "-ar" in args and args[args.index("-ar") + 1] == "16000"
        assert args[args.index("-ac") + 1] == "1"
        assert seen["stdin"] == b"opaque-amr-bytes"
        assert duration == pytest.approx(1.0)
        assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
        # the header sizes are real (ffmpeg cannot seek back on a pipe, so we write them)
        assert struct.unpack_from("<I", wav, 40)[0] == len(wav) - 44

    async def test_the_opus_command_makes_whatsapp_voice_notes(self):
        args = Transcoder().opus_args()
        assert "libopus" in args and args[args.index("-f") + 1] == "ogg" and args[-1] == "pipe:1"

    async def test_a_failed_conversion_is_unreadable_audio_without_ffmpegs_stderr(self):
        async def run(args, stdin):
            return 1, b"", b"/secret/path leaked metadata"

        with pytest.raises(AudioUnreadableError) as caught:
            await Transcoder(run=run).to_wav(b"junk")
        assert "secret" not in str(caught.value)

    async def test_missing_ffmpeg_is_a_configuration_error(self):
        async def run(args, stdin):
            raise FileNotFoundError

        with pytest.raises(TranscodeUnavailableError):
            await Transcoder(run=run).to_wav(b"x")

    def test_wav_header(self):
        wav = pcm_to_wav(b"\x00\x00" * 8)
        assert len(wav) == 44 + 16


# ---------------------------------------------------------------------------- adapters


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestWhisperAdapter:
    async def test_request_shape_and_confidence_from_segments(self):
        captured: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["auth"] = request.headers["authorization"]
            body = request.content.decode("latin-1")
            captured["body"] = body
            return httpx.Response(
                200,
                json={
                    "text": " Dolo 650 ka generic batao ",
                    "language": "hindi",
                    "duration": 4.2,
                    "segments": [
                        {
                            "start": 0.0,
                            "end": 4.2,
                            "text": "x",
                            "avg_logprob": -0.1,
                            "no_speech_prob": 0.02,
                        }
                    ],
                },
            )

        provider = WhisperProvider(
            "sk-test",
            "whisper-1",
            pricing=AudioPricing.load(),
            client=_client(handler),
        )
        result = await provider.transcribe(b"OggS....", "audio/ogg", "hi", timeout_s=5)
        assert captured["url"].endswith("/audio/transcriptions")
        assert captured["auth"] == "Bearer sk-test"
        body = str(captured["body"])
        assert 'name="model"' in body and "whisper-1" in body
        assert 'name="language"' in body and "verbose_json" in body
        assert result.text == "Dolo 650 ka generic batao"
        assert result.language == "hi"
        assert result.duration_s == 4.2
        assert result.confidence == pytest.approx(0.8865, abs=0.01)
        assert result.cost_usd == pytest.approx(0.006 * 4.2 / 60)

    async def test_auto_language_sends_no_language_field(self):
        seen: list[str] = []

        def handler(request):
            seen.append(request.content.decode("latin-1"))
            return httpx.Response(200, json={"text": "ok"})

        provider = WhisperProvider("k", "gpt-4o-transcribe", client=_client(handler))
        result = await provider.transcribe(b"x", "audio/ogg", "auto", timeout_s=5)
        assert 'name="language"' not in seen[0] and "verbose_json" not in seen[0]
        assert result.confidence is None

    @pytest.mark.parametrize(
        ("status", "error"), [(429, LLMRateLimitError), (503, LLMServerError), (401, LLMAuthError)]
    )
    async def test_http_errors_use_the_shared_taxonomy(self, status, error):
        provider = WhisperProvider(
            "k", "whisper-1", client=_client(lambda r: httpx.Response(status))
        )
        with pytest.raises(error):
            await provider.transcribe(b"x", "audio/ogg", "en", timeout_s=5)

    def test_noise_has_low_confidence(self):
        noisy = [{"avg_logprob": -1.5, "no_speech_prob": 0.9}]
        assert confidence_from_segments(noisy) < 0.05
        assert confidence_from_segments([]) is None


class TestSarvamAdapter:
    async def test_request_shape(self):
        captured: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["key"] = request.headers["api-subscription-key"]
            captured["body"] = request.content.decode("latin-1")
            return httpx.Response(200, json={"transcript": "मेरी दवाइयां", "language_code": "hi-IN"})

        provider = SarvamProvider("sv-test", "saaras:v3", mode="codemix", client=_client(handler))
        result = await provider.transcribe(b"x", "audio/ogg", "hi", timeout_s=5)
        body = str(captured["body"])
        assert captured["key"] == "sv-test"
        assert "hi-IN" in body and "saaras:v3" in body and "codemix" in body
        assert result.text == "मेरी दवाइयां"
        assert result.language == "hi"
        assert result.confidence is None  # language_probability is NOT an ASR confidence

    async def test_auto_detect_uses_unknown(self):
        seen: list[str] = []

        def handler(request):
            seen.append(request.content.decode("latin-1"))
            return httpx.Response(200, json={"transcript": "x", "language_code": None})

        provider = SarvamProvider("k", None, client=_client(handler))
        await provider.transcribe(b"x", "audio/ogg", "auto", timeout_s=5)
        assert "unknown" in seen[0] and 'name="model"' not in seen[0]


# ---------------------------------------------------------------------------- router


def _result(provider: str = "fake", text: str = "hello there", **kw) -> STTResult:
    return STTResult(
        text=text,
        language="en",
        confidence=kw.pop("confidence", 0.9),
        duration_s=kw.pop("duration_s", 3.0),
        provider=provider,
        model="m",
        latency_ms=1,
        **kw,
    )


def _router(*providers, transcoder=None, attempts=2) -> STTRouter:
    async def no_sleep(_s: float) -> None: ...

    return STTRouter(
        [STTSlot(p, CircuitBreaker(2, 60)) for p in providers],
        call_timeout_s=5,
        max_attempts=attempts,
        transcoder=transcoder,
        sleep=no_sleep,
    )


class TestSTTRouter:
    async def test_primary_answers(self):
        primary = FakeSTTProvider([_result("a")])
        result = await _router(primary).transcribe(b"x", "audio/ogg", "en")
        assert result.provider == "a" and result.fallback_used is False

    async def test_retry_on_a_server_error_then_success(self):
        primary = FakeSTTProvider([LLMServerError(), _result("a")])
        result = await _router(primary).transcribe(b"x", "audio/ogg", "en")
        assert result.provider == "a" and len(primary.calls) == 2

    async def test_falls_back_on_rate_limit_after_retries(self):
        primary = FakeSTTProvider([LLMRateLimitError(), LLMRateLimitError()])
        fallback = FakeSTTProvider([_result("b")])
        result = await _router(primary, fallback).transcribe(b"x", "audio/ogg", "en")
        assert result.provider == "b" and result.fallback_used is True

    async def test_bad_credentials_do_not_fall_back(self):
        primary = FakeSTTProvider([LLMAuthError()])
        fallback = FakeSTTProvider([_result("b")])
        with pytest.raises(LLMAuthError):
            await _router(primary, fallback).transcribe(b"x", "audio/ogg", "en")
        assert fallback.calls == []

    async def test_undecodable_audio_does_not_fall_back(self):
        primary = FakeSTTProvider([AudioUnreadableError()])
        fallback = FakeSTTProvider([_result("b")])
        with pytest.raises(AudioUnreadableError):
            await _router(primary, fallback).transcribe(b"x", "audio/ogg", "en")
        assert fallback.calls == []

    async def test_everything_down_is_unavailable(self):
        primary = FakeSTTProvider([LLMServerError(), LLMServerError()])
        with pytest.raises(LLMUnavailableError):
            await _router(primary).transcribe(b"x", "audio/ogg", "en")

    async def test_circuit_breaker_skips_a_dead_provider(self):
        primary = FakeSTTProvider([LLMServerError()] * 4)
        fallback = FakeSTTProvider([_result("b"), _result("b"), _result("b")])
        router = _router(primary, fallback, attempts=1)
        for _ in range(3):
            await router.transcribe(b"x", "audio/ogg", "en")
        assert len(primary.calls) == 2  # threshold 2: the third request skipped it

    async def test_a_short_clip_provider_is_skipped_for_a_long_note(self):
        short_only = FakeSTTProvider([_result("short")])
        short_only.max_duration_s = 30.0
        other = FakeSTTProvider([_result("long")])
        audio = fake_ogg_opus(90.0)
        result = await _router(short_only, other).transcribe(audio, "audio/ogg", "en")
        assert result.provider == "long" and short_only.calls == []

    async def test_a_format_the_provider_rejects_is_converted_once_in_memory(self):
        converted: list[bytes] = []

        async def run(args, stdin):
            converted.append(stdin)
            return 0, b"\x00\x00" * 32000, b""  # 2 seconds

        primary = FakeSTTProvider([LLMServerError(), LLMServerError()])
        primary.accepted_mimes = frozenset({"audio/wav"})
        fallback = FakeSTTProvider([_result("b", duration_s=0.0)])
        fallback.accepted_mimes = frozenset({"audio/wav"})
        result = await _router(primary, fallback, transcoder=Transcoder(run=run)).transcribe(
            b"amr-bytes", "audio/amr", "en"
        )
        assert len(converted) == 1  # converted once, shared by both providers
        assert primary.calls[0]["mime"] == "audio/wav"
        assert result.duration_s == pytest.approx(2.0)  # the exact decoded length

    async def test_cost_comes_from_the_provider_price(self):
        class Priced(FakeSTTProvider):
            def price(self, duration_s: float) -> float:
                return duration_s * 0.01

        provider = Priced([_result("a", duration_s=60.0)])
        result = await _router(provider).transcribe(b"x", "audio/ogg", "en")
        assert result.cost_usd == pytest.approx(0.6)

    async def test_no_time_left_means_unavailable_not_a_hang(self):
        deadline = Deadline(0.0)
        with pytest.raises(LLMUnavailableError):
            await _router(FakeSTTProvider([_result()])).transcribe(
                b"x", "audio/ogg", "en", deadline=deadline
            )


class TestFakeProvider:
    async def test_it_hears_what_the_fixture_says(self):
        audio = make_fake_audio("meds dikhao", language="hi", duration_s=3)
        assert audio.startswith(FAKE_AUDIO_MAGIC)
        result = await FakeSTTProvider().transcribe(audio, "audio/ogg", "hi", timeout_s=1)
        assert (result.text, result.language) == ("meds dikhao", "hi")

    async def test_real_audio_is_refused(self):
        with pytest.raises(AudioUnreadableError):
            await FakeSTTProvider().transcribe(b"OggS real", "audio/ogg", "hi", timeout_s=1)


def test_asyncio_marker_is_active():
    assert asyncio.iscoroutinefunction(FakeSTTProvider().transcribe)
