"""Lab normalisation and comparison (M12): value parsing, units, alias mapping, range priority,
categories, borderline, critical values (override everything) and trends."""

from datetime import date

import pytest

from app.labs.catalog import InMemoryLabRepository, load_seed
from app.labs.catalog import build_lab_tests as build_tests
from app.tools.lab_compare import (
    classify_against,
    compare_report,
    parse_categories,
    select_fallback,
)
from app.tools.lab_normalize import (
    LabIndex,
    normalise_unit,
    normalize_report,
    parse_value,
    to_canonical,
)
from tests.lab_support import extraction_of, lab_index, previous, row


@pytest.fixture
async def index() -> LabIndex:
    return await lab_index()


async def analyse(*rows, minimum=0.75, user_age=None, user_sex=None, prev=None, **kw):
    index = await lab_index()
    from app.schemas.process import PreviousLabResult

    extraction = normalize_report(extraction_of(*rows, **kw), index)
    return compare_report(
        extraction,
        index,
        minimum=minimum,
        user_age=user_age,
        user_sex=user_sex,
        previous=[PreviousLabResult.model_validate(p) for p in (prev or [])],
    )


class TestSeedData:
    def test_every_test_has_a_unique_code_aliases_and_a_source(self):
        tests = build_tests(load_seed())
        assert len(tests) >= 60
        assert len({t.code for t in tests}) == len(tests)
        for test in tests:
            assert test.source and test.explanation_en
            assert test.ranges or test.is_qualitative, test.code
            for variant in test.ranges:
                assert variant.low is None or variant.high is None or variant.low < variant.high

    def test_aliases_do_not_collide_across_tests(self):
        seen: dict[str, str] = {}
        for test in build_tests(load_seed()):
            for alias in {test.name.lower(), *(a.lower() for a in test.aliases)}:
                owner = seen.setdefault(alias, test.code)
                assert owner == test.code, f"{alias!r} belongs to {owner} and {test.code}"

    def test_critical_limits_are_attached(self):
        by_code = {t.code: t for t in build_tests(load_seed())}
        assert (by_code["HB"].critical_low, by_code["HB"].critical_high) == (7.0, 20.0)
        assert by_code["K"].critical_high == 6.5


class TestParseValue:
    @pytest.mark.parametrize(
        ("raw", "number", "comparator"),
        [
            ("7.2", 7.2, "="),
            ("1,25,000", 125000.0, "="),
            ("12,500", 12500.0, "="),
            ("7,2", 7.2, "="),
            ("<0.5", 0.5, "<"),
            ("> 1000", 1000.0, ">"),
            ("≥ 40", 40.0, ">"),
            ("1.2 x 10^3", 1200.0, "="),
            ("4.5 × 10³", 4500.0, "="),
            ("4.5e3", 4500.0, "="),
            ("7.2 %", 7.2, "="),
        ],
    )
    def test_numbers(self, raw, number, comparator):
        parsed = parse_value(raw)
        assert (parsed.kind, parsed.number, parsed.comparator) == ("numeric", number, comparator)

    @pytest.mark.parametrize("raw", ["Positive", "NEGATIVE", "Trace", "Nil", "++"])
    def test_qualitative(self, raw):
        assert parse_value(raw).kind == "qualitative"

    @pytest.mark.parametrize("raw", ["", "see note", "5-7", "abc 12"])
    def test_unparsed(self, raw):
        assert parse_value(raw).kind == "unparsed"


class TestUnits:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("gm/dL", "g/dl"),
            ("lakhs/cu.mm", "lakhs/cumm"),
            ("Lakh/cumm", "lakhs/cumm"),
            ("µIU/mL", "uiu/ml"),
            ("10³/µL", "10^3/ul"),
            ("x10^3/uL", "10^3/ul"),
            ("mg%", "mg/dl"),
            ("/cmm", "/cumm"),
            ("mL/min/1.73m²", "ml/min/1.73m2"),
            ("", ""),
        ],
    )
    def test_spelling(self, raw, expected):
        assert normalise_unit(raw) == expected

    async def test_platelets_in_lakhs_and_per_cumm_agree(self, index):
        plt = index.by_code["PLT"]
        assert to_canonical(plt, 2.5, normalise_unit("lakhs/cumm")) == pytest.approx(250)
        assert to_canonical(plt, 250000, normalise_unit("/cumm")) == pytest.approx(250)
        assert to_canonical(plt, 250, normalise_unit("10^3/uL")) == pytest.approx(250)

    async def test_glucose_and_creatinine_conversions(self, index):
        assert to_canonical(index.by_code["FBS"], 5.5, "mmol/l") == pytest.approx(99.1, abs=0.1)
        assert to_canonical(index.by_code["CREAT"], 88.4, "umol/l") == pytest.approx(1.0, abs=0.01)
        assert to_canonical(index.by_code["VITD"], 50, "nmol/l") == pytest.approx(20)

    async def test_hba1c_mmol_per_mol_uses_the_ngsp_formula(self, index):
        assert to_canonical(index.by_code["HBA1C"], 53, "mmol/mol") == pytest.approx(7.0, abs=0.01)

    async def test_an_unknown_unit_gives_no_canonical_value(self, index):
        assert to_canonical(index.by_code["HB"], 11.2, "furlongs") is None


class TestAliasMapping:
    @pytest.mark.parametrize(
        ("name", "unit", "code"),
        [
            ("HbA1c (Glycated Haemoglobin)", "%", "HBA1C"),
            ("Haemoglobin", "g/dL", "HB"),
            ("Hb", "g/dL", "HB"),
            ("Platelet Count", "lakhs/cumm", "PLT"),
            ("SGPT (ALT)", "U/L", "SGPT"),
            ("Sugar Fasting", "mg/dL", "FBS"),
            ("FBS", "mg/dL", "FBS"),
            ("Thyroid Stimulating Hormone (TSH)", "µIU/mL", "TSH"),
            ("Serum Creatinine", "mg/dL", "CREAT"),
            ("Vitamin D 25 Hydroxy", "ng/mL", "VITD"),
            ("Hemoglobbin", "g/dL", "HB"),  # a misspelling, by trigram similarity
            ("TOTAL CHOLESTEROL", "mg/dL", "CHOL"),
        ],
    )
    async def test_maps(self, index, name, unit, code):
        match = index.match(name, unit)
        assert match is not None and match.test.code == code

    async def test_a_glucose_result_in_percent_is_not_fasting_glucose(self, index):
        assert index.match("Glucose", "%") is None
        assert index.match("Fasting Glucose", "%") is None

    async def test_two_equally_likely_tests_are_not_guessed(self, index):
        assert index.match("Cholesterol HDL LDL ratio", "mg/dL") is None

    @pytest.mark.parametrize("name", ["Special Marker XYZ", "Procalcitonin", "T"])
    async def test_unknown_tests_stay_unmapped(self, index, name):
        assert index.match(name, "ng/mL") is None

    async def test_short_names_are_exact_alias_only(self, index):
        assert index.match("Hbx", "g/dL") is None


class TestFallbackRange:
    async def test_sex_specific_range_when_sex_is_known(self, index):
        variant, general = select_fallback(index.by_code["HB"], 40, "f")
        assert (variant.low, variant.high, general) == (12.0, 15.5, False)

    async def test_general_range_when_age_or_sex_is_unknown(self, index):
        variant, general = select_fallback(index.by_code["HB"], None, None)
        assert (variant.low, variant.high, general) == (12.0, 17.5, True)
        _, general = select_fallback(index.by_code["HB"], 40, None)
        assert general is True

    async def test_a_test_without_sex_variants_is_not_general_when_only_age_is_known(self, index):
        _, general = select_fallback(index.by_code["TSH"], 40, None)
        assert general is False

    async def test_children_have_no_fallback(self, index):
        variant, _ = select_fallback(index.by_code["HB"], 8, "f")
        assert variant is None


class TestClassifyAgainst:
    @pytest.mark.parametrize(
        ("value", "comparator", "low", "high", "expected"),
        [
            (11, "=", 12, 15, "low"),
            (16, "=", 12, 15, "high"),
            (12, "=", 12, 15, "normal"),
            (15, "=", 12, 15, "normal"),
            (0.3, "<", None, 5.7, "normal"),
            (0.5, "<", 0.6, 5.7, "low"),
            (6, "<", None, 5.7, "unknown"),
            (1000, ">", None, 450, "high"),
            (50, ">", 40, None, "normal"),
            (30, ">", 40, None, "unknown"),
            (1, "=", None, None, "unknown"),
        ],
    )
    def test_table(self, value, comparator, low, high, expected):
        assert classify_against(value, comparator, low, high) == expected


class TestRangePriority:
    async def test_the_labs_printed_range_beats_the_fallback(self):
        # Hb 12.2 is inside the fallback 12.0-15.5 but outside THIS lab's printed 12.5-16.0
        out = await analyse(row("Haemoglobin", "12.2", "g/dL", 12.5, 16.0, "12.5 - 16.0"))
        result = out.results[0]
        assert (result.status, result.range_basis, result.range_text) == (
            "low",
            "printed",
            "12.5–16",
        )

    async def test_the_printed_flag_is_used_when_the_range_is_unreadable(self):
        out = await analyse(row("Haemoglobin", "11.2", "g/dL", flag="L"))
        assert (out.results[0].status, out.results[0].range_basis) == ("low", "flag")

    async def test_a_low_confidence_range_is_not_trusted(self):
        out = await analyse(row("Haemoglobin", "11.2", "g/dL", 8.0, 9.0, "8 - 9", c_range=0.3))
        result = out.results[0]
        assert result.range_basis == "fallback" and result.status == "low"

    async def test_the_fallback_range_is_the_last_resort_and_is_flagged_general(self):
        out = await analyse(row("Haemoglobin", "11.2", "g/dL"))
        result = out.results[0]
        assert (result.status, result.range_basis) == ("low", "fallback")
        assert out.used_general_range is True

    async def test_age_and_sex_from_the_report_are_used_with_enough_confidence(self):
        out = await analyse(row("Haemoglobin", "12.2", "g/dL"), age=40, sex="m")
        assert out.results[0].status == "low"  # male range starts at 13.0
        assert out.used_general_range is False

    async def test_a_value_inside_the_range_is_normal(self):
        out = await analyse(row("Haemoglobin", "13.5", "g/dL", 12.0, 15.5, "12.0 - 15.5"))
        assert out.results[0].status == "normal"

    async def test_borderline_is_within_five_percent_of_a_limit(self):
        out = await analyse(row("Haemoglobin", "12.3", "g/dL", 12.0, 15.5, "12 - 15.5"))
        assert out.results[0].status == "borderline"

    async def test_an_unknown_test_is_compared_with_its_printed_range_but_never_explained(self):
        out = await analyse(row("Special Marker XYZ", "12", "U/L", 0, 10, "0 - 10"))
        result = out.results[0]
        assert (result.test_code, result.status, result.range_basis) == (None, "high", "printed")

    async def test_an_unknown_test_without_a_range_or_flag_stays_unknown(self):
        out = await analyse(row("Special Marker XYZ", "12", "U/L"))
        assert out.results[0].status == "unknown"
        assert out.unknown_count == 1


class TestCategories:
    def test_labelled_segments_are_parsed(self):
        cats = parse_categories("Non-diabetic < 5.7, Pre-diabetic 5.7 - 6.4, Diabetic >= 6.5")
        assert [c.label for c in cats] == ["Non-diabetic", "Pre-diabetic", "Diabetic"]
        assert cats[1].contains(6.0) and not cats[1].contains(6.5) and cats[2].contains(6.5)

    def test_a_plain_range_is_not_a_category_list(self):
        assert parse_categories("12.0 - 15.5") == []
        assert parse_categories(None) == []

    async def test_the_printed_category_is_shown_verbatim_and_never_invented(self):
        text = "Non-diabetic < 5.7, Pre-diabetic 5.7 - 6.4, Diabetic >= 6.5"
        out = await analyse(row("HbA1c", "6.0", "%", ref_text=text))
        result = out.results[0]
        assert result.category == "Pre-diabetic"
        # no flag: the status comes from the fallback range (< 5.6), not from the category label
        assert (result.status, result.range_basis) == ("high", "fallback")

    async def test_a_category_list_ignores_a_misread_low_high(self):
        text = "Deficient < 20, Insufficient 20 - 29, Sufficient 30 - 100"
        out = await analyse(row("Vitamin D", "14", "ng/mL", None, 20.0, text))
        result = out.results[0]
        assert result.category == "Deficient"
        assert result.range_basis == "fallback" and result.status == "low"


class TestCritical:
    @pytest.mark.parametrize(
        ("name", "value", "unit", "status"),
        [
            ("Haemoglobin", "6.2", "g/dL", "critical_low"),
            ("Potassium", "6.9", "mmol/L", "critical_high"),
            ("Sodium", "118", "mmol/L", "critical_low"),
            ("Platelet Count", "15000", "/cumm", "critical_low"),
            ("Platelet Count", "0.1", "lakhs/cumm", "critical_low"),
            ("Fasting Blood Sugar", "30", "mg/dL", "critical_low"),
            ("Fasting Blood Sugar", "28", "mmol/L", "critical_high"),  # 28 mmol/L = 504 mg/dL
            ("Serum Creatinine", "380", "umol/L", "critical_high"),  # 4.3 mg/dL
        ],
    )
    async def test_detected_in_canonical_units(self, name, value, unit, status):
        out = await analyse(row(name, value, unit))
        assert out.results[0].status == status
        assert out.has_critical is True

    async def test_critical_overrides_the_labs_own_normal_flag_and_range(self):
        out = await analyse(row("Potassium", "7.1", "mmol/L", 3.5, 8.0, "3.5 - 8.0", flag="N"))
        assert out.results[0].status == "critical_high"

    async def test_a_critical_value_read_with_low_confidence_is_still_raised_and_marked(self):
        out = await analyse(row("Haemoglobin", "5.9", "g/dL", c_value=0.4))
        result = out.results[0]
        assert result.status == "critical_low" and result.needs_confirmation is True

    async def test_a_limit_value_counts(self):
        out = await analyse(row("Platelet Count", ">1000", "10^3/uL"))
        assert out.results[0].status == "critical_high"

    async def test_a_normal_value_is_not_critical(self):
        out = await analyse(row("Haemoglobin", "13", "g/dL", 12.0, 15.5, "12 - 15.5"))
        assert out.has_critical is False


class TestConfidence:
    async def test_a_low_confidence_value_is_unknown_and_marked_for_confirmation(self):
        out = await analyse(row("Haemoglobin", "11.2", "g/dL", 12.0, 15.5, c_value=0.5))
        result = out.results[0]
        assert (result.status, result.needs_confirmation) == ("unknown", True)

    async def test_a_low_confidence_unit_is_unknown(self):
        out = await analyse(row("Haemoglobin", "11.2", "g/dL", 12.0, 15.5, c_unit=0.4))
        assert out.results[0].status == "unknown"

    async def test_a_low_confidence_name_is_unknown(self):
        out = await analyse(row("Haemoglobin", "11.2", "g/dL", 12.0, 15.5, c_name=0.3))
        assert out.results[0].status == "unknown"


class TestQualitative:
    async def test_positive_urine_protein_is_abnormal(self):
        out = await analyse(row("Urine Protein", "Positive"))
        assert out.results[0].status == "qualitative_abnormal"

    async def test_nil_is_normal(self):
        out = await analyse(row("Urine Glucose", "Nil"))
        assert out.results[0].status == "normal"

    async def test_an_unknown_qualitative_test_uses_the_labs_flag(self):
        assert (await analyse(row("Strange Antigen", "Reactive", flag="A"))).results[
            0
        ].status == "qualitative_abnormal"
        assert (await analyse(row("Strange Antigen", "Reactive"))).results[0].status == "unknown"


class TestTrends:
    async def test_direction_and_no_judgement(self):
        out = await analyse(
            row("HbA1c", "7.2", "%", None, 5.6, "< 5.6"),
            prev=[previous("HBA1C", 7.8, "%", date(2026, 3, 10))],
        )
        trend = out.results[0].trend
        assert trend is not None
        assert (trend.direction, trend.previous_value, trend.range_change) == ("down", 7.8, None)

    async def test_moving_into_the_range_is_noted(self):
        out = await analyse(
            row("HbA1c", "5.4", "%", None, 5.6, "< 5.6"),
            prev=[previous("HBA1C", 7.8, "%", date(2026, 3, 10))],
        )
        assert out.results[0].trend.range_change == "into_range"

    async def test_moving_out_of_the_range_is_noted(self):
        out = await analyse(
            row("Haemoglobin", "11.0", "g/dL", 12.0, 15.5, "12 - 15.5"),
            prev=[previous("HB", 13.0, "g/dl", date(2026, 3, 10))],
        )
        assert out.results[0].trend.range_change == "out_of_range"

    async def test_a_tiny_change_is_same(self):
        out = await analyse(
            row("Haemoglobin", "13.0", "g/dL", 12.0, 15.5, "12 - 15.5"),
            prev=[previous("HB", 13.05, "g/dl", date(2026, 3, 10))],
        )
        assert out.results[0].trend.direction == "same"

    async def test_the_most_recent_earlier_report_is_used_and_a_later_one_ignored(self):
        out = await analyse(
            row("Haemoglobin", "13.0", "g/dL", 12.0, 15.5, "12 - 15.5"),
            prev=[
                previous("HB", 9.0, "g/dl", date(2026, 1, 5)),
                previous("HB", 12.0, "g/dl", date(2026, 6, 5)),
                previous("HB", 5.0, "g/dl", date(2027, 1, 5)),
            ],
        )
        assert out.results[0].trend.previous_value == 12.0

    async def test_no_previous_result_no_trend(self):
        out = await analyse(row("Haemoglobin", "13.0", "g/dL", 12.0, 15.5, "12 - 15.5"))
        assert out.results[0].trend is None

    async def test_a_value_in_another_unit_is_compared_in_the_canonical_unit(self):
        out = await analyse(
            row("Fasting Blood Sugar", "5.5", "mmol/L", 3.9, 5.5, "3.9 - 5.5"),
            prev=[previous("FBS", 126.0, "mg/dl", date(2026, 3, 10))],
        )
        assert out.results[0].trend.direction == "down"


def test_the_in_memory_repository_matches_the_seed():
    import asyncio

    tests = asyncio.run(InMemoryLabRepository().all_tests())
    assert {t.code for t in tests} >= {"HB", "HBA1C", "TSH", "PLT", "VITD"}


class TestSeedWordingIsSafe:
    def test_no_explanation_or_question_trips_the_diagnosis_blocklist(self):
        from app.tools.lab_verify import BLOCKLIST, blocklist_hits

        data = load_seed()
        texts = [
            *data["generic_questions_en"],
            *data["generic_questions_hi"],
            data["generic_hi_line"],
        ]
        for test in data["tests"]:
            texts += [test["ex"], *test.get("q", [])]
        for text in texts:
            hits = [BLOCKLIST[int(i)] for i in blocklist_hits(text)]
            assert not hits, f"{text!r} contains {hits}"


class TestBorderlineMargin:
    async def test_a_narrow_range_is_not_mostly_borderline(self):
        out = await analyse(row("Sodium", "139", "mmol/L", 135, 145, "135 - 145"))
        assert out.results[0].status == "normal"
        out = await analyse(row("Sodium", "135.5", "mmol/L", 135, 145, "135 - 145"))
        assert out.results[0].status == "borderline"

    async def test_a_one_sided_range_uses_five_percent_of_the_limit(self):
        out = await analyse(row("Total Cholesterol", "195", "mg/dL", None, 200, "< 200"))
        assert out.results[0].status == "borderline"
        out = await analyse(row("Total Cholesterol", "150", "mg/dL", None, 200, "< 200"))
        assert out.results[0].status == "normal"
