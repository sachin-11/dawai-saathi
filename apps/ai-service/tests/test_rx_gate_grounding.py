"""Confidence gate (CLAUDE.md §2.3) and grounding verifier (§2.5), table-driven (M7)."""

from typing import Any

import pytest

from app.schemas.prescription import Medicine, PrescriptionExtraction
from app.schemas.process import Language
from app.tools.rx_compose import build_views, compose_payload, render_reply_text
from app.tools.rx_gate import apply_gate, unclear_fields
from app.tools.rx_grounding import numbers_in, verify_item, verify_items
from app.tools.rx_validate import validate_extraction
from tests.rx_support import extraction, f, medicine

MIN = 0.75


def ext(*medicines: dict[str, Any], **overrides: Any) -> PrescriptionExtraction:
    return validate_extraction(
        PrescriptionExtraction.model_validate(extraction(*medicines, **overrides)), MIN
    )


class TestGate:
    @pytest.mark.parametrize(
        ("overrides", "expected"),
        [
            ({}, []),
            ({"name": f("Dolo 650", 0.74)}, ["name"]),
            ({"name": f(None, 0.9)}, ["name"]),
            ({"dose": f("1 tablet", 0.5)}, ["dose"]),
            ({"dose": f(None, 0.0)}, ["dose"]),
            ({"frequency_code": f("1-0-1", 0.6)}, ["frequency"]),
            ({"frequency_code": f(None, 0.0)}, ["frequency"]),
            ({"name": f(None, 0.1), "dose": f(None, 0.1)}, ["name", "dose"]),
            # The threshold is inclusive: exactly 0.75 passes.
            ({"name": f("Dolo 650", 0.75)}, []),
            # Strength / duration / timings are NOT critical.
            ({"strength": f(None, 0.0), "duration_days": f(None, 0.0)}, []),
        ],
    )
    def test_unclear_fields(self, overrides, expected):
        validated = ext(medicine(**overrides)).medicines[0]
        assert unclear_fields(validated, MIN) == expected

    def test_sos_needs_only_a_readable_code(self):
        sos = medicine(frequency_code=f("SOS"), frequency_per_day=f(None, 0.0))
        assert unclear_fields(ext(sos).medicines[0], MIN) == []

    def test_all_confident_is_done(self):
        result = apply_gate(ext(medicine(), medicine(name=f("Pantop 40"))), MIN)
        assert result.extraction.status == "done" and result.warnings == []

    def test_some_low_confidence_is_needs_review_with_a_numbered_warning(self):
        result = apply_gate(ext(medicine(), medicine(name=f("Pantop 40"), dose=f(None, 0.0))), MIN)
        assert result.extraction.status == "needs_review"
        assert [m.low_confidence for m in result.extraction.medicines] == [False, True]
        assert [w.detail for w in result.warnings] == ["medicine 2: dose not clear"]

    def test_warning_details_never_contain_prescription_text(self):
        bad = medicine(name=f("SecretBrand", 0.2), raw_text=f("Tab. SecretBrand 1-0-1", 0.2))
        result = apply_gate(ext(medicine(), bad), MIN)
        assert all("Secret" not in w.detail for w in result.warnings)

    @pytest.mark.parametrize(
        ("kwargs", "failure"),
        [
            ({"is_prescription": False}, "not_a_prescription"),
            ({"image_quality": "unreadable"}, "unreadable"),
        ],
    )
    def test_not_a_prescription_or_unreadable_fails(self, kwargs, failure):
        result = apply_gate(ext(medicine(), **kwargs), MIN)
        assert result.extraction.status == "failed" and result.failure == failure

    def test_no_readable_name_fails_even_if_the_image_is_good(self):
        result = apply_gate(ext(medicine(name=f(None, 0.1))), MIN)
        assert result.extraction.status == "failed" and result.failure == "no_readable_medicine"

    def test_zero_medicines_fails(self):
        assert apply_gate(ext(), MIN).failure == "no_readable_medicine"

    def test_a_poor_photo_with_confident_values_is_still_done(self):
        assert apply_gate(ext(medicine(), image_quality="poor"), MIN).extraction.status == "done"

    def test_the_threshold_is_configurable(self):
        borderline = ext(medicine(name=f("Dolo 650", 0.6)))
        assert apply_gate(borderline, 0.5).extraction.status == "done"
        assert apply_gate(borderline, 0.9).extraction.status == "failed"


def payload_med(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "index": 1,
        "name": "Dolo 650",
        "form": "tablet",
        "strength": "650 mg",
        "dose": "1 tablet",
        "frequency_code": "1-0-1",
        "times_per_day": 2,
        "timings": ["morning", "night"],
        "food": "after",
        "duration_days": 5,
        "as_needed": False,
        "instructions": None,
    }
    base.update(overrides)
    return base


EN, HI = Language.en, Language.hi


class TestGrounding:
    @pytest.mark.parametrize(
        ("text", "language"),
        [
            ("Dolo 650 (tablet) — 1 tablet, morning and night, after food, for 5 days", EN),
            ("Dolo 650 — take 1 tablet twice daily after food for 5 days", EN),
            ("Dolo 650 (गोली) — 1 गोली, सुबह और रात, खाने के बाद, 5 दिन", HI),
            ("Dolo 650 — १ गोली, सुबह और रात, ५ दिन", HI),  # Devanagari digits
            ("DOLO 650 — 1 tablet, 650 mg", EN),
        ],
    )
    def test_grounded_lines_pass(self, text, language):
        assert verify_item(1, text, payload_med(), language) == []

    @pytest.mark.parametrize(
        ("text", "problem"),
        [
            ("1 tablet, morning and night", "name_missing"),
            ("Crocin — 1 tablet", "name_missing"),
            ("Dolo 650 — 1 tablet for 14 days", "number_not_in_data"),
            ("Dolo 650 — 3 tablets", "number_not_in_data"),
            ("Dolo 650 — 14 दिन", "number_not_in_data"),
            ("Dolo 650 — thrice daily", "number_word_not_in_data"),
            ("Dolo 650 — 1 tablet, also take Crocin", "unknown_word"),
            ("Dolo 650 — 1 tablet for fever", "unknown_word"),
            ("Dolo 650 — 1 tablet, causes drowsiness", "unknown_word"),
            ("Dolo 650 — 1 tablet, stop after food", "advice_phrase"),
            ("Dolo 650 — 1 गोली, बीमारी के लिए", "advice_phrase"),
            ("Dolo 650 — 1 गोली Crocin", "unknown_word"),
            ("", "empty_line"),
            ("Dolo 650 — 1 tablet\nand more", "line_has_newline"),
            ("Dolo 650 — " + "take " * 60, "line_too_long"),
        ],
    )
    def test_ungrounded_lines_are_caught(self, text, problem):
        assert problem in verify_item(1, text, payload_med(), EN if "गोली" not in text else HI)

    def test_words_from_the_medicines_own_data_are_allowed(self):
        med = payload_med(instructions="with warm water")
        assert verify_item(1, "Dolo 650 — with warm water", med, EN) == []

    def test_words_from_another_medicine_are_not_allowed(self):
        a = payload_med()
        b = payload_med(index=2, name="Pantop 40")
        problems = verify_items(
            [(1, "Dolo 650 — 1 tablet, Pantop"), (2, "Pantop 40 — 1 tablet")], [a, b], EN
        )
        assert "unknown_word" in problems

    def test_indexes_must_match_exactly_and_in_order(self):
        a, b = payload_med(), payload_med(index=2, name="Pantop 40")
        ok = [(1, "Dolo 650 — 1 tablet"), (2, "Pantop 40 — 1 tablet")]
        assert verify_items(ok, [a, b], EN) == []
        assert verify_items(ok[:1], [a, b], EN) == ["item_indexes_mismatch"]
        assert verify_items(ok[::-1], [a, b], EN) == ["item_indexes_mismatch"]
        assert verify_items([(1, "x"), (1, "y")], [a, b], EN) == ["item_indexes_mismatch"]

    def test_number_folding(self):
        assert numbers_in("५ दिन, 1,50 ml, 5.0, 650") == {"5", "1.5", "650"}


class TestTemplates:
    def views(self, *medicines: dict[str, Any], **overrides: Any):
        extracted = apply_gate(ext(*medicines, **overrides), MIN).extraction
        return extracted, build_views(extracted, MIN)

    def test_english_template_lists_every_medicine_and_flags_low_confidence(self):
        extracted, views = self.views(medicine(), medicine(name=f(None, 0.1)))
        text = render_reply_text(views, extracted, EN)
        assert text.startswith("📋 I found 2 medicines in your prescription:")
        assert (
            "1. Dolo 650 (tablet, 650 mg) — 1 tablet, morning and night, after food, for 5 days"
            in text
        )
        assert (
            "2. I could not read this medicine clearly. Please confirm with your pharmacist."
            in text
        )
        assert "⚠️ Some items could not be read clearly" in text

    def test_hindi_template_uses_devanagari_and_localised_units(self):
        extracted, views = self.views(medicine(dose=f("2 tablets")))
        text = render_reply_text(views, extracted, HI)
        assert "आपकी पर्ची में 1 दवाई मिलीं" in text
        assert "2 गोली, सुबह और रात, खाने के बाद, 5 दिन" in text

    def test_a_readable_name_with_an_unclear_dose_shows_the_name_and_what_is_unclear(self):
        extracted, views = self.views(medicine(), medicine(name=f("Pantop 40"), dose=f(None, 0.0)))
        text = render_reply_text(views, extracted, EN)
        assert "2. Pantop 40 (tablet, 650 mg) — I could not read the dose clearly" in text

    def test_as_needed_and_per_day_phrasing(self):
        sos = medicine(
            frequency_code=f("SOS"),
            frequency_per_day=f(None, 0.0),
            timings=f(None, 0.0),
            duration_days=f(None, 0.0),
        )
        tds = medicine(
            name=f("Cough Syp"),
            frequency_code=f("TDS"),
            frequency_per_day=f(3),
            timings=f(None, 0.0),
        )
        extracted, views = self.views(sos, tds)
        text = render_reply_text(views, extracted, EN)
        assert "only when needed" in text and "3 times a day" in text

    def test_duplicates_and_poor_quality_are_noted(self):
        a = medicine()
        b = medicine(frequency_code=f("OD"), frequency_per_day=f(1), timings=f(None, 0.0))
        extracted, views = self.views(a, b, image_quality="poor")
        text = render_reply_text(views, extracted, EN)
        assert "appears more than once" in text and "photo was not very clear" in text

    def test_the_llm_payload_has_only_readable_medicines(self):
        _, views = self.views(medicine(), medicine(name=f(None, 0.1)))
        payload = compose_payload(views)
        assert [p["index"] for p in payload] == [1]
        assert Medicine  # keep the import used
