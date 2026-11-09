"""The lab verifier (M12): it must catch what a renderer bug or a poisoned catalog could produce."""

import pytest

from app.safety.disclaimers import DISCLAIMERS
from app.schemas.process import Language, PreviousLabResult
from app.tools.lab_compare import compare_report
from app.tools.lab_normalize import normalize_report
from app.tools.lab_render import render_all_tests, render_lab_reply
from app.tools.lab_verify import blocklist_hits, lab_failures
from tests.lab_support import extraction_of, lab_index, row

EN = Language.en
HB = row("Haemoglobin", "11.2", "g/dL", 12.0, 15.5, "12 - 15.5", "L", "CBC")
K = row("Potassium", "6.9", "mmol/L", 3.5, 5.1, "3.5 - 5.1", "H", "Electrolytes")


async def prepared(*rows, **kw):
    index = await lab_index()
    data = normalize_report(extraction_of(*rows, **kw), index)
    data = compare_report(data, index, minimum=0.75, user_age=None, user_sex=None, previous=[])
    return data, index


async def reply_of(*rows, language=EN, **kw):
    data, index = await prepared(*rows, **kw)
    return data, index, render_lab_reply(data, index, language, minimum=0.75)


async def test_the_rendered_reply_passes():
    data, index, text = await reply_of(HB, K)
    assert lab_failures(text, data, index, EN) == []


@pytest.mark.parametrize(
    ("old", "new", "code"),
    [
        ("11.2", "12.2", "lab_number_not_in_data"),
        ("12–15.5", "12–16.5", "lab_number_not_in_data"),
        ("• Haemoglobin:", "• Ferritin:", "lab_unknown_test_name"),
        ("— below the range", "— you have anaemia", "lab_diagnosis_wording"),
        (
            "Please show the report to your doctor.",
            "Start taking iron tablets.",
            "lab_diagnosis_wording",
        ),
        (DISCLAIMERS[EN], "", "disclaimer_missing"),
    ],
)
async def test_tampered_replies_are_caught(old, new, code):
    data, index, text = await reply_of(HB)
    assert old in text
    assert code in lab_failures(text.replace(old, new), data, index, EN)


async def test_a_missing_critical_line_is_caught():
    data, index, text = await reply_of(K)
    assert text.startswith("🚨")
    without = text.split("\n", 2)[2]
    assert "critical_line_missing" in lab_failures(without, data, index, EN)


async def test_a_dropped_out_of_range_result_is_caught():
    data, index, text = await reply_of(HB, K)
    dropped = "\n".join(line for line in text.splitlines() if not line.startswith("• Haemoglobin"))
    assert "out_of_range_not_mentioned" in lab_failures(dropped, data, index, EN)


async def test_a_diagnosis_in_hindi_and_hinglish_is_caught():
    for phrase in ("आपको डायबिटीज़ है", "aapko diabetes hai", "thyroid ki bimari hai", "दवा बंद करें"):
        assert blocklist_hits(f"HbA1c 7.2 — {phrase}"), phrase


def test_our_own_disclaimer_does_not_trip_the_blocklist():
    assert blocklist_hits(DISCLAIMERS[EN]) == []
    assert blocklist_hits(DISCLAIMERS[Language.hi]) == []


@pytest.mark.parametrize("word", ["accurate", "secure", "dietitian"])
def test_whole_words_only(word):
    assert blocklist_hits(f"the {word} result") == []


async def test_all_tests_view_lists_every_test_grouped_by_section():
    data, index = await prepared(
        HB,
        K,
        row("Total Leucocyte Count", "7200", "/cumm", 4000, 11000, "4000 - 11000", None, "CBC"),
    )
    text = render_all_tests(data, index, EN, minimum=0.75)
    assert "CBC" in text and "Electrolytes" in text
    for name in ("Haemoglobin", "Potassium", "Total Leucocyte Count"):
        assert name in text
    assert DISCLAIMERS[EN] in text and len(text) <= 4096


async def test_all_tests_view_stays_within_the_limit_for_80_results():
    rows = [
        row(f"Test {i}", "5", "U/L", 0, 10, "0 - 10", None, f"Section {i // 10}") for i in range(80)
    ]
    data, index = await prepared(*rows)
    text = render_all_tests(data, index, EN, minimum=0.75)
    assert len(text) <= 4096 and DISCLAIMERS[EN] in text and "more tests are not shown" in text


def test_previous_lab_result_schema_is_strict():
    with pytest.raises(ValueError):
        PreviousLabResult.model_validate(
            {
                "test_code": "HB",
                "value": 1,
                "unit": "g/dl",
                "report_date": "2026-01-01",
                "name": "x",
            }
        )
