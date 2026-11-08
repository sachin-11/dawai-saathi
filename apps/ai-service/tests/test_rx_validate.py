"""Deterministic prescription validators (M7): table-driven, no LLM."""

from typing import Any

import pytest
from pydantic import ValidationError

from app.schemas.prescription import Medicine, PrescriptionExtraction
from app.tools.rx_validate import (
    dose_in_range,
    duration_in_range,
    merge_duplicates,
    normalise_strength,
    parse_food_relation,
    parse_frequency_code,
    validate_extraction,
    validate_medicine,
)
from tests.rx_support import extraction, f, medicine

MIN = 0.75


def med(**overrides: Any) -> Medicine:
    return Medicine.model_validate(medicine(**overrides))


class TestFrequencyCodes:
    @pytest.mark.parametrize(
        ("code", "per_day", "timings", "as_needed"),
        [
            ("1-0-1", 2, ("morning", "night"), False),
            ("1-1-1", 3, ("morning", "afternoon", "night"), False),
            ("0-0-1", 1, ("night",), False),
            ("1-0-0", 1, ("morning",), False),
            ("0-1-0", 1, ("afternoon",), False),
            ("1-1-1-1", 4, ("morning", "afternoon", "evening", "night"), False),
            ("1/2-0-1/2", 2, ("morning", "night"), False),
            ("1 - 0 - 1", 2, ("morning", "night"), False),
            ("OD", 1, (), False),
            ("o.d.", 1, (), False),
            ("BD", 2, (), False),
            ("bid", 2, (), False),
            ("TDS", 3, (), False),
            ("QID", 4, (), False),
            ("HS", 1, ("night",), False),
            ("SOS", None, (), True),
            ("PRN", None, (), True),
            ("q6h", 4, (), False),
            ("q8h", 3, (), False),
            ("twice daily", 2, (), False),
            ("Twice a day", 2, (), False),
            ("thrice a day", 3, (), False),
            ("3 times a day", 3, (), False),
            ("din me 2 baar", 2, (), False),
            ("once daily", 1, (), False),
            ("daily", 1, (), False),
        ],
    )
    def test_known_codes(self, code, per_day, timings, as_needed):
        info = parse_frequency_code(code)
        assert info is not None
        assert (info.per_day, info.timings, info.as_needed) == (per_day, timings, as_needed)

    @pytest.mark.parametrize(
        "code", [None, "", "  ", "0-0-0", "q7h", "1-?-1", "xyz", "as directed"]
    )
    def test_unknown_codes_are_none_never_guessed(self, code):
        assert parse_frequency_code(code) is None


class TestFoodRelation:
    @pytest.mark.parametrize(
        ("texts", "expected"),
        [
            (["1-0-1 PC"], "after"),
            (["1-0-0 A.C."], "before"),
            (["after food"], "after"),
            (["khane ke baad"], "after"),
            (["khane se pehle"], "before"),
            (["subah khali pet"], "before"),
            (["with milk"], "with"),
            (["खाने के बाद"], "after"),
            (["before food, after food"], None),  # contradictory: silent
            (["1-0-1"], None),
            ([None, ""], None),
        ],
    )
    def test_cases(self, texts, expected):
        assert parse_food_relation(*texts) == expected

    def test_abbreviations_can_be_switched_off_for_free_text(self):
        # "ac" inside a brand line must not be read as "before food"
        assert parse_food_relation("Tab. Ac 10", allow_abbreviations=False) is None


class TestStrength:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("650mg", "650 mg"),
            ("650 MG", "650 mg"),
            ("0.5 mg", "0.5 mg"),
            ("500 mcg", "500 mcg"),
            ("500 ug", "500 mcg"),
            ("5 ml", "5 ml"),
            ("100 IU", "100 iu"),
            ("2%", "2%"),
            ("125 mg/5 ml", "125 mg/5 ml"),
            ("1 g", "1 g"),
        ],
    )
    def test_valid(self, text, expected):
        assert normalise_strength(text) == expected

    @pytest.mark.parametrize("text", ["", "mg", "six fifty mg", "650", "0 mg", "6s0 mg", "650 xx"])
    def test_invalid_is_none(self, text):
        assert normalise_strength(text) is None

    def test_none_stays_none(self):
        assert normalise_strength(None) is None


class TestRanges:
    @pytest.mark.parametrize(
        ("dose", "form", "ok"),
        [
            ("1 tablet", "tablet", True),
            ("1/2 tab", "tablet", True),
            ("2 tablets", "tablet", True),
            ("4 tablets", "tablet", True),
            ("5 tablets", "tablet", False),
            ("10 tablets", "tablet", False),
            ("6 capsules", "capsule", False),
            ("3", "tablet", True),
            ("5 ml", "syrup", True),
            ("80 ml", "syrup", False),
            ("0 tablet", "tablet", False),
            ("2 puffs", "inhaler", True),
            ("ek goli", "tablet", True),
            (None, "tablet", True),
            ("as directed", "tablet", True),
        ],
    )
    def test_dose(self, dose, form, ok):
        assert dose_in_range(dose, form) is ok

    @pytest.mark.parametrize(
        ("days", "ok"), [(1, True), (5, True), (365, True), (0, False), (366, False), (None, False)]
    )
    def test_duration(self, days, ok):
        assert duration_in_range(days) is ok


class TestValidateMedicine:
    def test_a_consistent_medicine_is_unchanged_in_substance(self):
        out = validate_medicine(med(), MIN)
        assert out.frequency_per_day.value == 2 and out.frequency_per_day.confidence == 0.95
        assert out.timings.value == ["morning", "night"]
        assert out.validation_notes == []

    def test_the_written_code_beats_the_models_derived_count(self):
        out = validate_medicine(med(frequency_code=f("TDS"), frequency_per_day=f(2, 0.95)), MIN)
        assert out.frequency_per_day.value == 3  # trust the code
        assert out.frequency_per_day.confidence < MIN  # and say we were unsure
        assert "frequency_code_overrides_model" in out.validation_notes

    def test_timings_come_from_the_code_when_the_code_names_them(self):
        out = validate_medicine(med(timings=f(["morning", "afternoon"], 0.9)), MIN)
        assert out.timings.value == ["morning", "night"]
        assert "timings_overridden_by_code" in out.validation_notes

    def test_sos_makes_it_as_needed_without_a_daily_count(self):
        out = validate_medicine(med(frequency_code=f("SOS"), frequency_per_day=f(2)), MIN)
        assert out.as_needed is True and out.frequency_per_day.value is None
        assert "frequency_code_overrides_model" in out.validation_notes

    def test_as_needed_with_a_count_but_no_known_code_drops_the_count(self):
        out = validate_medicine(
            med(as_needed=True, frequency_code=f("if required"), frequency_per_day=f(3)), MIN
        )
        assert out.frequency_per_day.value is None
        assert "as_needed_has_no_daily_count" in out.validation_notes

    def test_more_than_six_per_day_lowers_confidence_below_the_threshold(self):
        out = validate_medicine(med(frequency_code=f("q2h"), frequency_per_day=f(12)), MIN)
        assert out.frequency_per_day.value == 12
        assert out.frequency_per_day.confidence < MIN
        assert "frequency_out_of_range" in out.validation_notes

    def test_a_dose_of_ten_tablets_is_out_of_range(self):
        out = validate_medicine(med(dose=f("10 tablets")), MIN)
        assert out.dose.confidence < MIN and "dose_out_of_range" in out.validation_notes

    def test_an_impossible_duration_is_dropped_not_shown(self):
        out = validate_medicine(med(duration_days=f(4000)), MIN)
        assert out.duration_days.value is None and out.duration_days.confidence == 0
        assert "duration_out_of_range" in out.validation_notes

    def test_a_malformed_strength_is_dropped(self):
        out = validate_medicine(med(strength=f("6s0 mg")), MIN)
        assert out.strength.value is None and "strength_invalid" in out.validation_notes

    def test_strength_is_normalised(self):
        assert validate_medicine(med(strength=f("650MG")), MIN).strength.value == "650 mg"

    def test_the_written_food_abbreviation_beats_the_model(self):
        out = validate_medicine(
            med(frequency_code=f("1-0-1 AC"), relation_to_food=f("after", 0.9)), MIN
        )
        assert out.relation_to_food.value == "before"
        assert out.relation_to_food.confidence < MIN
        assert "food_relation_overrides_model" in out.validation_notes

    def test_hindi_instruction_fills_a_missing_food_relation(self):
        out = validate_medicine(
            med(relation_to_food=f(None, 0.0), instructions=f("khane ke baad", 0.9)), MIN
        )
        assert out.relation_to_food.value == "after"

    def test_timings_with_the_wrong_count_are_dropped(self):
        out = validate_medicine(
            med(
                frequency_code=f("BD"),
                frequency_per_day=f(2),
                timings=f(["morning", "afternoon", "night"], 0.9),
            ),
            MIN,
        )
        assert out.timings.value is None and "timings_count_mismatch" in out.validation_notes

    def test_validators_never_touch_the_input(self):
        original = med(frequency_code=f("TDS"))
        validate_medicine(original, MIN)
        assert original.frequency_per_day.value == 2


class TestDuplicatesAndOverall:
    def test_an_exact_repeat_is_merged(self):
        merged = merge_duplicates([med(), med()])
        assert len(merged) == 1 and "duplicate_merged" in merged[0].validation_notes

    def test_same_name_different_schedule_is_kept_and_flagged(self):
        merged = merge_duplicates([med(), med(frequency_code=f("OD"), frequency_per_day=f(1))])
        assert len(merged) == 2
        assert all("duplicate_name" in m.validation_notes for m in merged)

    def test_overall_confidence_is_the_weakest_critical_field(self):
        ext = PrescriptionExtraction.model_validate(
            extraction(
                med().model_dump(), med(name=f("Pantop 40"), dose=f("1 tablet", 0.55)).model_dump()
            )
        )
        out = validate_extraction(ext, MIN)
        assert out.overall_confidence == 0.55

    def test_no_medicines_means_zero_confidence(self):
        out = validate_extraction(PrescriptionExtraction.model_validate(extraction()), MIN)
        assert out.overall_confidence == 0.0

    def test_a_missing_dose_counts_as_zero(self):
        ext = PrescriptionExtraction.model_validate(extraction(med(dose=f(None, 0.9)).model_dump()))
        assert validate_extraction(ext, MIN).overall_confidence == 0.0


class TestSchema:
    def test_unknown_keys_are_rejected_so_phi_cannot_slip_in(self):
        for key in ("patient_name", "doctor_name", "phone", "address", "hospital"):
            with pytest.raises(ValidationError):
                PrescriptionExtraction.model_validate(extraction(**{key: "x"}))

    def test_more_than_twenty_medicines_are_rejected(self):
        with pytest.raises(ValidationError):
            PrescriptionExtraction.model_validate(extraction(*[medicine() for _ in range(21)]))

    def test_confidence_must_be_between_zero_and_one(self):
        with pytest.raises(ValidationError):
            Medicine.model_validate(medicine(name=f("x", 1.5)))

    def test_the_schema_has_no_phi_field_names(self):
        names = set(PrescriptionExtraction.model_json_schema()["properties"]) | set(
            Medicine.model_json_schema()["properties"]
        )
        assert not names & {"patient", "patient_name", "doctor", "doctor_name", "phone", "address"}


class TestMergeKeepsWhatDiffers:
    def test_a_repeat_with_an_unreadable_dose_is_not_silently_dropped(self):
        merged = merge_duplicates([med(), med(dose=f(None, 0.0))])
        assert len(merged) == 2  # the unreadable one must still reach the confidence gate
