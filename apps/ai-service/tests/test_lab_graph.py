"""The lab report branches of the graph (M12): image -> reply, critical values first, unknown tests,
unreadable reports, trends, the verifier's fallback, typed questions ("TSH 6.2 matlab kya?")."""

from datetime import date
from typing import Any

import pytest

from app.labs.catalog import (
    FailingLabRepository,
    InMemoryLabRepository,
    build_lab_tests,
    load_seed,
)
from app.labs.service import LabService
from app.llm.fake import FakeProvider
from app.safety.disclaimers import DISCLAIMERS
from app.schemas.process import Intent, Language
from tests.graph_support import nodes_run, run_graph, text_request
from tests.lab_support import (
    CLASSIFY_LAB,
    lab_image_request,
    lab_service,
    previous,
    report,
    row,
)
from tests.rx_support import fake_fetch, sample_jpeg


@pytest.fixture(autouse=True)
def _jpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
    )


HB_LOW = row("Haemoglobin", "11.2", "g/dL", 12.0, 15.5, "12.0 - 15.5", "L", "CBC")
HBA1C = row("HbA1c (Glycated Haemoglobin)", "7.2", "%", None, 5.6, "< 5.6", "H", "Blood sugar")
TLC_OK = row("Total Leucocyte Count", "7200", "/cumm", 4000, 11000, "4000 - 11000", None, "CBC")
UNKNOWN = row("Special Marker XYZ", "12", "U/L", None, None, None, None, "Other")


async def read(*rows: dict[str, Any], language="en", script_extra=None, **kwargs):
    prev = kwargs.pop("prev", None)
    provider = FakeProvider([CLASSIFY_LAB, report(*rows, **kwargs), *(script_extra or [])])
    request = lab_image_request(language, previous=prev)
    return await run_graph(provider, request, labs=lab_service())


class TestHappyPath:
    async def test_report_reply_english(self):
        output, _ = await read(HB_LOW, TLC_OK, HBA1C)
        assert output.intent is Intent.lab_report
        assert nodes_run(output) == [
            "prepare_image", "classify", "vision_extract_lab", "lab_normalize", "lab_compare",
            "lab_gate", "composer", "verifier",
        ]  # fmt: skip
        text = output.reply.text
        assert text.startswith("🧪 Your report (12 Nov 2026) — 3 tests:")
        assert "✅ 1 within the normal range" in text
        assert "• Haemoglobin: 11.2 g/dL (lab range 12–15.5) — below the range" in text
        assert "• HbA1c (Glycated Haemoglobin): 7.2 % (lab range < 5.6) — above the range" in text
        assert "average blood sugar level over roughly the last 3 months" in text
        assert "❓ You can ask your doctor:" in text
        assert "not a diagnosis" in text and DISCLAIMERS[Language.en] in text
        assert [b.id for b in output.reply.buttons] == [
            "lab:all:{document_id}",
            "lab:wrong:{document_id}",
        ]
        assert output.reply.buttons[0].title == "See all tests"
        assert output.extraction is not None and output.extraction.kind == "lab_report"
        assert output.extraction.status == "done"

    async def test_hindi_reply_shows_no_unreviewed_hindi_explanation(self):
        output, _ = await read(HB_LOW, HBA1C, language="hi")
        text = output.reply.text
        assert text.startswith("🧪 आपकी रिपोर्ट (12 Nov 2026) — 2 टेस्ट:")
        assert "• Haemoglobin: 11.2 g/dL (लैब रेंज 12–15.5) — रेंज से कम" in text
        assert "इस जाँच का मतलब" not in text  # the generic line is only for the DB, never repeated
        assert DISCLAIMERS[Language.hi] in text

    async def test_the_labs_range_is_shown_not_a_general_one(self):
        output, _ = await read(row("Haemoglobin", "12.2", "g/dL", 12.5, 16.0, "12.5 - 16.0"))
        assert "• Haemoglobin: 12.2 g/dL (lab range 12.5–16) — below the range" in output.reply.text

    async def test_the_general_range_note_when_age_and_sex_are_missing(self):
        output, _ = await read(row("Haemoglobin", "11.2", "g/dL"))
        assert "(general range 12–17.5)" in output.reply.text
        assert "Your age or sex was not on the report" in output.reply.text

    async def test_a_trend_line_appears_without_judgement(self):
        provider = FakeProvider([CLASSIFY_LAB, report(HBA1C)])
        request = lab_image_request(previous=[previous("HBA1C", 7.8, "%", date(2026, 3, 10))])
        output, _ = await run_graph(provider, request, labs=lab_service())
        text = output.reply.text
        assert "📈 Since your last report:" in text
        assert "• HbA1c (Glycated Haemoglobin): 7.8 % (Mar 2026) → 7.2 % (Nov 2026)" in text
        for word in ("improved", "worse", "better", "deteriorat"):
            assert word not in text.lower()

    async def test_the_reply_is_the_same_for_the_same_extraction(self):
        first, _ = await read(HB_LOW, HBA1C)
        second, _ = await read(HB_LOW, HBA1C)
        assert first.reply.text == second.reply.text

    async def test_the_report_age_and_sex_stay_on_the_document_extraction_only(self):
        output, _ = await read(HB_LOW, age=40, sex="f")
        assert output.extraction.patient_age.value == 40
        dumped = output.extraction.model_dump_json()
        assert "patient_name" not in dumped


class TestCritical:
    async def test_the_critical_line_is_first_and_lists_the_test(self):
        output, _ = await read(
            row("Potassium", "6.9", "mmol/L", 3.5, 5.1, "3.5 - 5.1", "H", "Electrolytes"), HB_LOW
        )
        lines = output.reply.text.splitlines()
        assert lines[0] == (
            "🚨 Some values are very high or very low (Potassium). "
            "Please contact your doctor today."
        )
        assert "• Potassium: 6.9 mmol/L" in output.reply.text and "very high" in output.reply.text
        assert [w.type.value for w in output.warnings] == ["critical_value"]
        assert output.warnings[0].detail == "K:critical_high"

    async def test_critical_in_hindi(self):
        output, _ = await read(row("Haemoglobin", "5.9", "g/dL"), language="hi")
        assert output.reply.text.splitlines()[0].startswith("🚨 कुछ वैल्यू बहुत ज़्यादा या बहुत कम हैं")
        assert "आज ही अपने डॉक्टर से संपर्क करें" in output.reply.text

    async def test_a_critical_value_read_with_low_confidence_says_so(self):
        output, _ = await read(row("Haemoglobin", "5.9", "g/dL", c_value=0.4))
        assert "could not read them clearly" in output.reply.text.splitlines()[0]

    async def test_a_needs_review_document_still_shows_the_critical_line(self):
        output, _ = await read(row("Haemoglobin", "5.9", "g/dL"), overall=0.3)
        assert output.reply.text.startswith("🚨")
        assert output.extraction.status == "needs_review"


class TestUnknownAndUnclear:
    async def test_an_unknown_test_is_not_explained(self):
        output, _ = await read(HB_LOW, UNKNOWN)
        text = output.reply.text
        assert "Special Marker XYZ" in text
        assert "measures" not in text.split("Special Marker XYZ", 1)[1].split("\n")[0]
        assert output.extraction.results[1].test_code is None

    async def test_unclear_results_are_listed_for_confirmation(self):
        output, _ = await read(HB_LOW, row("Platelet Count", "250", "10^3/uL", c_value=0.4))
        text = output.reply.text
        assert "🔎 I could not read these clearly." in text
        assert "• Platelet Count" in text and "250" not in text

    async def test_many_out_of_range_results_are_summarised_not_dropped(self):
        rows = [row(f"Test {i}", "99", "U/L", 0, 10, "0 - 10", "H", "Other") for i in range(1, 16)]
        output, _ = await read(*rows)
        assert "… and 3 more outside the range." in output.reply.text
        assert len(output.reply.text) <= 4096


class TestUnreadable:
    async def test_not_a_lab_report(self):
        output, _ = await read(is_lab=False)
        assert output.intent is Intent.other
        assert output.extraction is None

    async def test_unreadable_pages_are_not_guessed(self):
        output, _ = await read(quality="unreadable")
        assert "could not read this report clearly" in output.reply.text
        assert output.extraction is not None and output.extraction.status == "failed"
        assert output.extraction.results == []

    async def test_no_results_on_the_page(self):
        output, _ = await read()
        assert "could not find any test results" in output.reply.text
        assert output.extraction.status == "failed"

    async def test_a_broken_structure_is_retried_once_with_the_strict_prompt_then_given_up(self):
        provider = FakeProvider([CLASSIFY_LAB, "nope", "nope", "nope", "nope"])
        output, _ = await run_graph(provider, lab_image_request(), labs=lab_service())
        assert "could not read this report clearly" in output.reply.text
        assert output.extraction.status == "failed"
        assert nodes_run(output).count("vision_extract_lab") == 2
        assert len(provider.calls) == 5  # classify + 2 attempts x (answer + repair)

    async def test_a_model_supplied_status_is_overwritten(self):
        tampered = row("Haemoglobin", "11.2", "g/dL", 12.0, 15.5, "12 - 15.5")
        tampered["status"] = "normal"
        tampered["test_code"] = "TSH"
        output, _ = await read(tampered)
        assert output.extraction.results[0].test_code == "HB"
        assert output.extraction.results[0].status == "low"

    async def test_phi_keys_are_rejected_by_the_schema(self):
        bad = report(HB_LOW)
        bad["patient_name"] = "Asha Verma"
        provider = FakeProvider([CLASSIFY_LAB, bad, bad, bad, bad])
        output, _ = await run_graph(provider, lab_image_request(), labs=lab_service())
        assert output.extraction.status == "failed"
        assert "Asha" not in output.reply.text

    async def test_the_lab_catalog_being_down_is_said_not_hidden(self):
        service = LabService(FailingLabRepository())
        provider = FakeProvider([CLASSIFY_LAB, report(HB_LOW)])
        output, _ = await run_graph(provider, lab_image_request(), labs=service)
        assert "cannot look up the lab test information" in output.reply.text


class TestEmergencyGuardNeverSeesReportText:
    async def test_a_report_mentioning_chest_pain_is_not_an_emergency(self):
        noisy = row("Chest pain remark", "see doctor", None)
        output, _ = await read(HB_LOW, noisy)
        assert output.emergency is False
        assert "emergency_guard" not in nodes_run(output)


class TestVerifierFallback:
    async def test_a_diagnosis_phrase_in_the_catalog_text_triggers_the_plain_template(self):
        tests = build_lab_tests(load_seed())
        poisoned = [
            t if t.code != "HB" else _with_explanation(t, "You have anaemia if this is low.")
            for t in tests
        ]
        service = LabService(InMemoryLabRepository(poisoned))
        provider = FakeProvider([CLASSIFY_LAB, report(HB_LOW)])
        output, _ = await run_graph(provider, lab_image_request(), labs=service)
        text = output.reply.text
        assert "You have anaemia" not in text
        assert "• Haemoglobin: 11.2 g/dL (lab range 12–15.5) — below the range" in text
        assert DISCLAIMERS[Language.en] in text
        assert output.debug_trace is not None
        assert nodes_run(output)[-1] == "rx_fallback"


def _with_explanation(test, text):
    from dataclasses import replace

    return replace(test, explanation_en=text)


class TestTypedQuestion:
    async def ask(self, text: str, language="en", labs=None):
        provider = FakeProvider([])
        return await run_graph(provider, text_request(text, language), labs=labs or lab_service())

    async def test_tsh_question_gives_explanation_and_general_range_only(self):
        output, _ = await self.ask("TSH 6.2 matlab kya?")
        assert output.intent is Intent.lab_report
        assert nodes_run(output) == [
            "emergency_guard", "redact", "emergency_classifier", "classify", "lab_question",
            "composer", "verifier",
        ]  # fmt: skip
        text = output.reply.text
        assert "TSH (thyroid stimulating hormone)" in text
        assert "A typical adult range is 0.4–4 mIU/L" in text
        assert "You mentioned 6.2" in text
        assert "compare it with the range printed on YOUR report" in text
        assert "high" not in text.lower().replace("thyroid", "")  # no verdict on 6.2
        assert output.reply.buttons == []
        assert output.extraction is None

    async def test_unknown_test(self):
        output, _ = await self.ask("report me Procalcitonin 5 aaya matlab kya?")
        assert "do not have information about this test yet" in output.reply.text

    async def test_no_test_named(self):
        output, _ = await self.ask("meri report ka matlab")
        assert "which test" in output.reply.text.lower() or "information" in output.reply.text

    async def test_hindi_question_has_no_unreviewed_hindi_explanation(self):
        output, _ = await self.ask("TSH 6.2 matlab kya?", language="hi")
        assert "आपने 6.2 बताया" in output.reply.text
        assert "इस जाँच का मतलब" not in output.reply.text

    async def test_an_emergency_in_the_question_still_comes_first(self):
        output, _ = await self.ask("TSH report aur seene me dard ho raha hai")
        assert output.emergency is True


@pytest.mark.parametrize("language", ["en", "hi"])
async def test_no_labs_wired_keeps_the_old_placeholder(language):
    provider = FakeProvider([CLASSIFY_LAB])
    output, _ = await run_graph(provider, lab_image_request(language), labs=None)
    assert output.intent is Intent.lab_report
    assert output.extraction is None
