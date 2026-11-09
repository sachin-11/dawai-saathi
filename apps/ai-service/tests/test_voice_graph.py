"""M13: a voice note travels the SAME graph as typed text. Fake speech provider, fake LLM."""

from dataclasses import replace
from typing import Any

import pytest

from app.llm.breaker import CircuitBreaker
from app.llm.fake import FakeProvider
from app.llm.stt.fake import FakeSTTProvider, make_fake_audio
from app.llm.stt.router import STTRouter, STTSlot
from app.llm.tts import fake_ogg_opus
from app.llm.types import LLMServerError
from app.pipeline.base import PipelineContext, PipelineOutput
from app.pipeline.graph import GraphPipeline
from app.schemas.process import Command, ProcessRequest
from tests.graph_support import NOT_EMERGENCY, seeded_catalog
from tests.interaction_support import core_service
from tests.rx_support import fake_fetch, make_ctx


def voice_request(language: str = "en", want_spoken: bool = False) -> ProcessRequest:
    return ProcessRequest.model_validate(
        {
            "request_id": "wamid.voice-1",
            "user": {"language": language, "age": None, "sex": None},
            "input": {
                "type": "audio",
                "media_url": "http://localhost:9000/b/k?s=1",
                "mime": "audio/ogg",
            },
            "options": {"want_spoken": want_spoken},
        }
    )


async def run_voice(
    spoken: str,
    monkeypatch: pytest.MonkeyPatch,
    *,
    language: str = "en",
    confidence: float | None = 0.95,
    duration_s: float = 4.0,
    audio: bytes | None = None,
    stt_script: list[Any] | None = None,
    llm_script: list[Any] | None = None,
    want_spoken: bool = False,
    catalog: Any = "seeded",
    no_stt: bool = False,
) -> tuple[PipelineOutput, PipelineContext, FakeSTTProvider]:
    data = audio or make_fake_audio(spoken, confidence=confidence, duration_s=duration_s)
    monkeypatch.setattr("app.graph.nodes.transcribe.fetch_media", fake_fetch(data, "audio/ogg"))
    provider = FakeSTTProvider(stt_script)
    router = (
        None
        if no_stt
        else STTRouter([STTSlot(provider, CircuitBreaker(5, 60))], call_timeout_s=5, max_attempts=1)
    )
    ctx = make_ctx(
        FakeProvider(llm_script or []),
        catalog=seeded_catalog() if catalog == "seeded" else catalog,
        interactions=core_service(),
    )
    ctx = replace(ctx, stt=router)
    output = await GraphPipeline().run(voice_request(language, want_spoken), ctx)
    return output, ctx, provider


def path_of(output: PipelineOutput) -> list[str]:
    assert output.debug_trace is not None
    return [e.node for e in output.debug_trace]


# ---------------------------------------------------------------------------- the same graph


class TestSameGraphAsText:
    async def test_a_generic_question_by_voice_is_answered_like_a_typed_one(self, monkeypatch):
        output, _, _ = await run_voice("Dolo 650 ka generic batao", monkeypatch)
        assert path_of(output)[:5] == [
            "transcribe", "emergency_guard", "redact", "emergency_classifier", "classify",
        ]  # fmt: skip
        assert output.intent.value == "generic_query"
        assert "Dolo" in output.reply.text

    async def test_the_reply_starts_with_what_we_understood(self, monkeypatch):
        output, _, _ = await run_voice("Dolo 650 ka generic batao", monkeypatch)
        assert output.reply.text.startswith("🎧 You asked: “Dolo 650 ka generic batao”")
        assert output.transcript_redacted_short == "Dolo 650 ka generic batao"

    async def test_hindi_users_get_the_hindi_line(self, monkeypatch):
        output, _, _ = await run_voice("Dolo 650 ka generic batao", monkeypatch, language="hi")
        assert output.reply.text.startswith("🎧 आपने पूछा: “Dolo 650 ka generic batao”")

    async def test_the_line_is_redacted_and_short(self, monkeypatch):
        long_tail = " dawai " * 40
        output, _, _ = await run_voice(
            f"Dolo 650 ka generic batao mera number 9876543210 hai{long_tail}", monkeypatch
        )
        short = output.transcript_redacted_short
        assert short is not None and len(short) <= 120
        assert "9876543210" not in short and "9876543210" not in output.reply.text

    async def test_greetings_and_chatter_do_not_get_the_line(self, monkeypatch):
        output, _, _ = await run_voice("hello", monkeypatch)
        assert "You asked" not in output.reply.text

    async def test_a_devanagari_drug_question_works_through_the_roman_copy(self, monkeypatch):
        output, _, _ = await run_voice("डोलो 650 का जेनेरिक बताओ", monkeypatch, language="hi")
        assert output.intent.value in {"generic_query", "out_of_scope", "other"}
        # the Devanagari original is what the user sees quoted back
        assert "डोलो" in (output.transcript_redacted_short or "")


# ---------------------------------------------------------------------------- emergency on voice


class TestEmergencyOnVoice:
    @pytest.mark.parametrize(
        "spoken",
        [
            "mere seene me bahut dard ho raha hai",
            "सीने में दर्द हो रहा है",
            "मुझे सांस नहीं आ रही",
            "mujhe jeena nahi hai",
        ],
    )
    async def test_both_scripts_are_checked_and_the_template_is_instant(self, spoken, monkeypatch):
        output, _, _ = await run_voice(spoken, monkeypatch, llm_script=[])
        assert output.emergency is True
        assert "112" in output.reply.text
        assert path_of(output) == ["transcribe", "emergency_guard", "templates"]

    async def test_no_you_asked_line_and_no_transcript_for_an_emergency(self, monkeypatch):
        output, _, _ = await run_voice("seene me dard", monkeypatch, want_spoken=True)
        assert "You asked" not in output.reply.text
        assert output.transcript_redacted_short is None
        assert output.spoken_text is None  # emergencies are never spoken

    async def test_self_harm_names_tele_manas(self, monkeypatch):
        output, _, _ = await run_voice("mujhe jeena nahi hai", monkeypatch)
        assert "14416" in output.reply.text

    async def test_a_low_confidence_partial_transcript_is_still_guarded(self, monkeypatch):
        output, _, _ = await run_voice("seene me dard", monkeypatch, confidence=0.05)
        assert output.emergency is True

    async def test_a_noisy_note_with_no_emergency_words_asks_to_repeat_after_the_guard(
        self, monkeypatch
    ):
        output, _, _ = await run_voice("uh hmm the the", monkeypatch, confidence=0.1)
        assert output.emergency is False
        assert "again" in output.reply.text.lower() and "112" in output.reply.text
        # both emergency stages ran before the "please repeat" reply
        assert path_of(output)[:4] == [
            "transcribe",
            "emergency_guard",
            "redact",
            "emergency_classifier",
        ]
        assert path_of(output)[-1] == "templates" and "classify" not in path_of(output)

    async def test_the_classifier_stage_also_runs_on_a_voice_transcript(self, monkeypatch):
        classifier_yes = {"is_emergency": True, "category": "cardiac", "confidence": 0.9}
        output, _, _ = await run_voice(
            "my father is not responding at all",
            monkeypatch,
            llm_script=[classifier_yes],
        )
        assert output.emergency is True

    async def test_an_empty_transcript_is_unclear_not_an_error(self, monkeypatch):
        output, _, _ = await run_voice("", monkeypatch)
        assert output.emergency is False and "again" in output.reply.text.lower()


# ---------------------------------------------------------------------------- failures


class TestFailures:
    async def test_a_note_over_the_limit_is_not_transcribed(self, monkeypatch):
        output, _, provider = await run_voice("anything", monkeypatch, audio=fake_ogg_opus(300.0))
        assert "shorter" in output.reply.text.lower()
        assert provider.calls == []  # nothing was sent to a provider

    async def test_duration_reported_by_the_provider_is_checked_too(self, monkeypatch):
        output, _, _ = await run_voice("hello there", monkeypatch, duration_s=500.0)
        assert "shorter" in output.reply.text.lower()

    async def test_speech_service_down_says_so_and_names_112(self, monkeypatch):
        output, _, _ = await run_voice(
            "x", monkeypatch, stt_script=[LLMServerError(), LLMServerError()]
        )
        assert output.emergency is False
        assert "type" in output.reply.text.lower() and "112" in output.reply.text

    async def test_no_provider_configured_is_the_same_honest_reply(self, monkeypatch):
        output, _, _ = await run_voice("x", monkeypatch, no_stt=True)
        assert "112" in output.reply.text

    async def test_undecodable_audio_asks_to_repeat(self, monkeypatch):
        output, _, _ = await run_voice("x", monkeypatch, audio=b"not audio at all")
        assert "again" in output.reply.text.lower()


# ---------------------------------------------------------------------------- commands by voice


class TestCommandsByVoice:
    @pytest.mark.parametrize(
        ("spoken", "command"),
        [
            ("meds dikhao", Command.meds),
            ("reminder band karo", Command.stop_reminders),
            ("le li", Command.reminder_taken),
            ("kha li", Command.reminder_taken),
            ("voice off", Command.voice_off),
            ("delete my data", Command.delete),
            ("मेरी दवाइयां", Command.meds),
        ],
    )
    async def test_the_command_is_detected_after_the_emergency_stages(
        self, spoken, command, monkeypatch
    ):
        output, _, _ = await run_voice(spoken, monkeypatch, llm_script=[NOT_EMERGENCY])
        assert output.detected_command is command
        assert "emergency_guard" in path_of(output)
        assert "extract_query" not in path_of(output)

    async def test_delete_by_voice_is_only_detected_never_executed_here(self, monkeypatch):
        """The AI service has no database write path at all; the gateway answers with a button."""
        output, _, _ = await run_voice("delete my data", monkeypatch, llm_script=[NOT_EMERGENCY])
        assert output.detected_command is Command.delete
        assert output.extraction is None

    async def test_a_command_reply_has_no_you_asked_line_and_no_speech(self, monkeypatch):
        output, _, _ = await run_voice(
            "meds dikhao", monkeypatch, llm_script=[NOT_EMERGENCY], want_spoken=True
        )
        assert "You asked" not in output.reply.text and output.spoken_text is None

    async def test_an_emergency_phrase_beats_a_command_word(self, monkeypatch):
        output, _, _ = await run_voice("help seene me dard", monkeypatch)
        assert output.emergency is True and output.detected_command is None

    async def test_a_sentence_containing_a_command_word_is_not_a_command(self, monkeypatch):
        output, _, _ = await run_voice(
            "Dolo 650 ka generic batao", monkeypatch, llm_script=[NOT_EMERGENCY]
        )
        assert output.detected_command is None


# ---------------------------------------------------------------------------- drug names by voice


class TestDrugNamesByVoice:
    async def test_a_name_we_cannot_match_confidently_is_never_answered(self, monkeypatch):
        output, _, _ = await run_voice("Zorbex 500 ka generic batao", monkeypatch)
        assert "type the medicine name" in output.reply.text
        assert "You asked" in output.reply.text

    async def test_the_same_name_typed_gets_the_normal_not_found_reply(self):
        # contrast: typed text keeps the M8 behaviour (no voice-specific wording)
        from tests.graph_support import run_graph, text_request

        output, _ = await run_graph(
            FakeProvider([]), text_request("Zorbex 500 ka generic batao"), seeded_catalog()
        )
        assert "type the medicine name" not in output.reply.text

    async def test_an_interaction_question_with_an_unheard_name_asks_for_it_in_writing(
        self, monkeypatch
    ):
        output, _, _ = await run_voice("Zorbex aur Dolo saath le sakte hain", monkeypatch)
        assert "type the medicine name" in output.reply.text


# ---------------------------------------------------------------------------- spoken text


class TestSpokenText:
    async def test_off_unless_the_user_asked_for_it(self, monkeypatch):
        output, _, _ = await run_voice("Dolo aur Combiflam saath le sakte hain?", monkeypatch)
        assert output.spoken_text is None

    async def test_an_interaction_answer_may_be_spoken_in_full(self, monkeypatch):
        output, _, _ = await run_voice(
            "Dolo aur Combiflam saath le sakte hain?", monkeypatch, want_spoken=True
        )
        assert output.intent.value == "interaction_query"
        assert output.spoken_text is not None and len(output.spoken_text) <= 600

    async def test_generic_price_lists_are_never_spoken(self, monkeypatch):
        output, _, _ = await run_voice("Dolo 650 ka generic batao", monkeypatch, want_spoken=True)
        assert output.intent.value == "generic_query" and output.spoken_text is None

    async def test_help_is_never_spoken(self, monkeypatch):
        output, _, _ = await run_voice("what can you do", monkeypatch, want_spoken=True)
        assert output.spoken_text is None
