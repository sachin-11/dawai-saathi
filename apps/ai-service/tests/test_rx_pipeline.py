"""The prescription pipeline end to end, with a scripted fake LLM (M7)."""

import json
from typing import Any

import pytest

from app.llm.fake import FakeProvider
from app.llm.types import LLMServerError
from app.pipeline.minimal import MinimalPipeline
from app.pipeline.rx import RxPipeline
from app.schemas.process import InputType, Intent
from tests.rx_support import (
    CLASSIFY_RX,
    extraction,
    f,
    fake_fetch,
    image_request,
    make_ctx,
    medicine,
    sample_jpeg,
)

PIPELINE = RxPipeline(MinimalPipeline())


@pytest.fixture(autouse=True)
def _jpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
    )


def lines_for(*medicines: dict[str, Any], language_hi: bool = False) -> dict[str, Any]:
    """A grounded composer answer for the given (clear) medicines."""
    return {
        "items": [
            {"index": i, "text": f"{m['name']['value']} — 1 tablet, morning and night"}
            for i, m in enumerate(medicines, start=1)
        ]
    }


class TestHappyPath:
    async def test_clear_prescription_gives_a_grounded_reply_with_buttons(self):
        meds = [
            medicine(),
            medicine(
                name=f("Pantop 40"),
                frequency_code=f("OD"),
                frequency_per_day=f(1),
                timings=f(None, 0.0),
            ),
        ]
        provider = FakeProvider([CLASSIFY_RX, extraction(*meds), lines_for(*meds)])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))

        assert output.intent is Intent.prescription
        assert output.extraction is not None and output.extraction.status == "done"
        assert "Dolo 650" in output.reply.text and "Pantop 40" in output.reply.text
        assert output.reply.text.rstrip().endswith("before acting on this.")
        assert [b.id.split(":")[1] for b in output.reply.buttons] == [
            "reminders",
            "generic",
            "wrong",
        ]
        assert all(len(b.title) <= 20 for b in output.reply.buttons)
        assert output.warnings == []

    async def test_the_composer_gets_structured_data_only_never_the_image_or_raw_text(self):
        meds = [medicine(raw_text=f("Tab. Dolo 650 RAW-OCR-LINE-XYZ"))]
        provider = FakeProvider([CLASSIFY_RX, extraction(*meds), lines_for(*meds)])
        await PIPELINE.run(image_request("en"), make_ctx(provider))

        classify, extract, compose = provider.calls
        assert classify["images"] == 1 and extract["images"] == 1
        assert compose["images"] == 0
        compose_text = " ".join(m.content for m in compose["messages"])
        assert "RAW-OCR-LINE-XYZ" not in compose_text
        user_json = json.loads(compose["messages"][-1].content)
        assert set(user_json) == {"medicines"}
        assert compose["temperature"] == 0


class TestLowConfidence:
    async def test_an_unreadable_name_is_flagged_and_never_shown(self):
        bad = medicine(name=f(None, 0.1), raw_text=f("Tab. ??? 1-0-1", 0.3))
        provider = FakeProvider([CLASSIFY_RX, extraction(medicine(), bad), lines_for(medicine())])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))

        assert output.extraction is not None and output.extraction.status == "needs_review"
        assert output.extraction.medicines[1].low_confidence is True
        assert "2. I could not read this medicine clearly" in output.reply.text
        assert [w.type.value for w in output.warnings] == ["low_confidence"]
        assert "medicine 2" in output.warnings[0].detail
        assert "???" not in output.reply.text

    async def test_nothing_readable_asks_for_a_new_photo_and_lists_no_medicine(self):
        bad = medicine(name=f(None, 0.1))
        provider = FakeProvider([CLASSIFY_RX, extraction(bad)])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert output.extraction is not None and output.extraction.status == "failed"
        assert "could not read any medicine" in output.reply.text
        assert output.reply.buttons == []
        assert len(provider.calls) == 2  # no composer call

    async def test_schema_failure_after_repair_says_so_and_never_guesses(self):
        provider = FakeProvider([CLASSIFY_RX, {"nonsense": 1}, {"still": "bad"}])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert output.extraction is not None and output.extraction.status == "needs_review"
        assert output.extraction.medicines == []
        assert "will not guess" in output.reply.text

    async def test_a_hallucinated_extra_phi_key_is_a_schema_failure(self):
        bad = extraction(medicine(), patient_name="Ramesh Kumar")
        provider = FakeProvider([CLASSIFY_RX, bad, bad])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert output.extraction is not None and output.extraction.medicines == []
        assert "Ramesh" not in output.reply.text


class TestGrounding:
    async def test_a_hallucinated_medicine_in_a_line_falls_back_to_the_template(self):
        meds = [medicine()]
        lie = {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet, also take Crocin 500"}]}
        provider = FakeProvider([CLASSIFY_RX, extraction(*meds), lie])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert "Crocin" not in output.reply.text
        assert (
            "Dolo 650 (tablet, 650 mg) — 1 tablet, morning and night, after food, for 5 days"
            in (output.reply.text)
        )

    async def test_a_number_not_in_the_data_falls_back_to_the_template(self):
        lie = {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet, for 14 days"}]}
        provider = FakeProvider([CLASSIFY_RX, extraction(medicine()), lie])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert "14" not in output.reply.text and "for 5 days" in output.reply.text

    async def test_a_failing_composer_still_answers_from_the_template(self):
        provider = FakeProvider([CLASSIFY_RX, extraction(medicine()), LLMServerError()])
        output = await PIPELINE.run(image_request("hi"), make_ctx(provider))
        assert "Dolo 650" in output.reply.text and "5 दिन" in output.reply.text


class TestRouting:
    async def test_a_lab_report_gets_the_coming_soon_template(self):
        provider = FakeProvider([{"kind": "lab_report", "quality": "good", "confidence": 0.9}])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert output.intent is Intent.lab_report and "coming soon" in output.reply.text
        assert len(provider.calls) == 1

    async def test_a_medicine_strip_and_other_images_are_politely_declined(self):
        strip = FakeProvider([{"kind": "medicine_strip", "quality": "good", "confidence": 0.9}])
        assert "strip" in (await PIPELINE.run(image_request("en"), make_ctx(strip))).reply.text
        other = FakeProvider([{"kind": "other", "quality": "good", "confidence": 0.9}])
        output = await PIPELINE.run(image_request("en"), make_ctx(other))
        assert output.intent is Intent.other and "clear photo" in output.reply.text

    async def test_an_unsure_classifier_is_treated_as_other(self):
        provider = FakeProvider([{"kind": "prescription", "quality": "good", "confidence": 0.2}])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert output.intent is Intent.other and len(provider.calls) == 1

    async def test_audio_goes_to_the_inner_pipeline(self):
        provider = FakeProvider()
        request = image_request("en").model_copy(
            update={"input": image_request().input.model_copy(update={"type": InputType.audio})}
        )
        # Audio is still the static acknowledgement and never reaches a model.
        output = await PIPELINE.run(request, make_ctx(provider))
        assert provider.calls == [] and output.intent is Intent.other


class TestPhiAndFakeMode:
    async def test_free_text_is_redacted_before_it_is_stored_or_shown(self):
        meds = [
            medicine(
                instructions=f("Review with Dr. Ramesh Sharma, call 9876543210", 0.9),
                raw_text=f("Tab. Dolo 650 1-0-1 ph 9876543210"),
            )
        ]
        provider = FakeProvider(
            [CLASSIFY_RX, extraction(*meds, notes_for_user=["mail a@b.com"]), lines_for(*meds)]
        )
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert output.extraction is not None
        stored = output.extraction.model_dump_json()
        assert "9876543210" not in stored and "a@b.com" not in stored
        assert "9876543210" not in output.reply.text

    async def test_default_fake_mode_returns_the_sample_prescription(self, client, monkeypatch):
        monkeypatch.setattr(
            "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
        )
        body = {
            "request_id": "wamid.fake-mode",
            "user": {"language": "hi", "age": None, "sex": None},
            "input": {
                "type": "image",
                "media_url": "http://localhost:9000/b/k?s=1",
                "mime": "image/jpeg",
            },
        }
        res = await client.post(
            "/v1/process", json=body, headers={"X-Service-Token": "test-service-token"}
        )
        data = res.json()
        assert res.status_code == 200 and data["intent"] == "prescription"
        assert data["extraction"]["status"] == "needs_review"
        assert len(data["extraction"]["medicines"]) == 3
        assert "Dolo 650" in data["reply"]["text"] and "Pantop 40" in data["reply"]["text"]
        assert [b["id"].split(":")[1] for b in data["reply"]["buttons"]] == [
            "reminders",
            "generic",
            "wrong",
        ]
        assert data["meta"]["prompt_version"].count("rx_") >= 3
        assert data["warnings"][0]["type"] == "low_confidence"
