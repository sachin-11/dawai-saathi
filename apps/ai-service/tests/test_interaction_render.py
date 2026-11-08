"""Interaction wording and its verifier (M11): severity wording, honest gaps, no 'stop' advice."""

import itertools

import pytest

from app.interactions.effects import EFFECTS
from app.interactions.render import (
    GENERIC_EN,
    GENERIC_HI,
    MAX_SHOWN,
    PREFIX,
    TEXT,
    render_block,
    render_details,
    render_finding,
    render_query_reply,
    shown_findings,
)
from app.interactions.verify import advice_to_stop, interaction_failures
from app.schemas.interactions import InteractionFinding, InteractionReport, UncheckedMedicine
from app.schemas.process import Language
from tests.interaction_support import pair

EN, HI = Language.en, Language.hi


def interaction(severity="major", effect="bleeding", labels=("Brufen", "Warf"), **kw):
    return InteractionFinding(
        type="interaction",
        severity=severity,
        salt_a="ibuprofen",
        salt_b="warfarin",
        labels=list(labels),
        effect_code=effect,
        management_key=severity,
        **kw,
    )


def duplicate(salt="paracetamol", overdose=True, labels=("Dolo 650", "Combiflam")):
    return InteractionFinding(
        type="duplicate_ingredient",
        salt_a=salt,
        salt_b=salt,
        labels=list(labels),
        management_key="duplicate_overdose" if overdose else "duplicate",
    )


def report(*findings, checked=2, unchecked=(), ok=True):
    return InteractionReport(
        findings=list(findings), checked_count=checked, unchecked=list(unchecked), database_ok=ok
    )


class TestSeverityWording:
    def test_major_is_urgent_and_names_both_medicines(self):
        text = render_finding(interaction("major"), EN)
        assert text.startswith("⚠️ Important:") and "Brufen and Warf" in text
        assert "talk to your doctor today" in text

    def test_major_in_hindi(self):
        text = render_finding(interaction("major"), HI)
        assert text.startswith("⚠️ ज़रूरी:") and "आज ही अपने डॉक्टर" in text

    def test_moderate_asks_for_caution_without_urgency(self):
        text = render_finding(interaction("moderate", "kidney_bp"), EN)
        assert text.startswith("• ") and "Important" not in text
        assert "ask your doctor or pharmacist" in text

    def test_minor_is_never_in_the_main_reply(self):
        block = render_block(report(interaction("minor")), EN)
        assert "taking them together" not in block
        assert TEXT[EN]["minor_only"] in block

    def test_the_effect_comes_from_the_table_not_a_model(self):
        for code, (en, hi) in EFFECTS.items():
            assert en in render_finding(interaction(effect=code), EN)
            assert hi in render_finding(interaction(effect=code), HI)

    def test_an_unknown_effect_code_still_gives_a_true_generic_sentence(self):
        assert "may affect how the medicines work" in render_finding(interaction(effect="zzz"), EN)

    def test_a_duplicate_names_the_salt_and_adds_no_dose_advice(self):
        text = render_finding(duplicate(), EN)
        assert "both contain paracetamol" in text and "too much of the same medicine" in text
        assert "mg" not in text and "dose" not in text.lower()

    def test_the_plain_duplicate_has_no_overdose_sentence(self):
        assert "too much" not in render_finding(duplicate("amlodipine", overdose=False), EN)

    def test_missing_labels_fall_back_to_this_medicine(self):
        assert "this medicine" in render_finding(interaction(labels=("", "")), EN)


class TestBlock:
    def test_at_most_three_are_shown_and_the_rest_is_counted(self):
        findings = [interaction("major", labels=(f"A{i}", f"B{i}")) for i in range(5)]
        block = render_block(report(*findings), EN)
        assert block.count("Important:") == MAX_SHOWN
        assert "2 more note(s)" in block

    def test_nothing_found_never_says_safe(self):
        block = render_block(report(checked=2), EN)
        assert "no known interaction" in block and "does not mean there is none" in block
        assert "safe" not in block.lower()
        hindi = render_block(report(checked=2), HI)
        assert "इसका मतलब यह नहीं कि कोई खतरा नहीं" in hindi

    def test_with_one_checkable_medicine_nothing_is_claimed(self):
        assert render_block(report(checked=1), EN) == ""

    def test_a_database_problem_is_said_not_hidden(self):
        block = render_block(report(ok=False, checked=0), EN)
        assert "could not check" in block and "no known interaction" not in block

    def test_unchecked_medicines_are_listed_and_not_called_safe(self):
        block = render_block(
            report(checked=1, unchecked=[UncheckedMedicine(ref="x", label="Mystery")]), EN
        )
        assert "Mystery" in block and "does not mean they are safe" in block

    def test_unchecked_without_a_name_adds_nothing(self):
        assert render_block(report(checked=1, unchecked=[UncheckedMedicine(ref="x")]), EN) == ""

    def test_shown_findings_skip_minor_and_keep_duplicates(self):
        rep = report(interaction("major"), duplicate(), interaction("minor"))
        assert [f.management_key for f in shown_findings(rep)] == ["major", "duplicate_overdose"]


class TestQueryReply:
    def test_the_typed_names_are_echoed_then_the_block(self):
        text = render_query_reply(["Dolo", "Combiflam"], report(duplicate()), EN)
        assert text and text.startswith("💊 You asked about: Dolo and Combiflam.")
        assert "both contain paracetamol" in text

    def test_nothing_to_say_returns_none(self):
        assert render_query_reply(["A", "B"], report(checked=1), EN) is None


class TestDetails:
    def row(self, **kw):
        return pair("ibuprofen", "warfarin", "major", "bleeding", source="Curated list", **kw)

    def test_details_show_management_and_source(self):
        rep = report(interaction("major"))
        rows = {("ibuprofen", "warfarin"): self.row()}
        text = render_details(rep.findings, rows, rep, EN)
        assert "Full details" in text and "Please ask your doctor or pharmacist" in text
        assert "Source: Curated list" in text

    def test_unreviewed_hindi_uses_the_safe_generic_line(self):
        rep = report(interaction("major"))
        rows = {("ibuprofen", "warfarin"): self.row(management_hi="MACHINE TRANSLATED")}
        text = render_details(rep.findings, rows, rep, HI)
        assert GENERIC_HI in text and "MACHINE TRANSLATED" not in text

    def test_reviewed_hindi_is_used(self):
        rep = report(interaction("major"))
        rows = {("ibuprofen", "warfarin"): self.row(hi_reviewed=True, management_hi="समीक्षित पंक्ति")}
        assert "समीक्षित पंक्ति" in render_details(rep.findings, rows, rep, HI)

    def test_minor_findings_appear_in_the_details(self):
        rep = report(interaction("minor"))
        rows = {("ibuprofen", "warfarin"): self.row()}
        assert "taking them together" in render_details(rep.findings, rows, rep, EN)

    def test_an_empty_details_view_still_does_not_say_safe(self):
        text = render_details([], {}, report(checked=3), EN)
        assert "does not mean there is none" in text

    def test_a_missing_row_still_gets_a_generic_management_line(self):
        rep = report(interaction("major"))
        assert GENERIC_EN in render_details(rep.findings, {}, rep, EN)


class TestVerifier:
    def ok(self, rep, text, language=EN, **kw):
        kw.setdefault("required", False)
        kw.setdefault("whole_reply_blocklist", False)
        return interaction_failures(rep, text, language, **kw)

    def test_the_exact_block_passes(self):
        rep = report(interaction("major"), duplicate())
        assert self.ok(rep, "Medicines...\n\n" + render_block(rep, EN)) == []

    def test_a_missing_duplicate_is_caught(self):
        rep = report(interaction("major"), duplicate())
        partial = render_finding(interaction("major"), EN)
        assert "interaction_block_missing" in self.ok(rep, partial)

    def test_an_interaction_not_in_the_findings_is_caught(self):
        rep = report(checked=2)
        sneaky = render_block(rep, EN) + "\n" + render_finding(interaction("major"), EN)
        failures = self.ok(rep, sneaky)
        assert "interaction_not_in_findings" in failures and "severity_mismatch" in failures

    def test_a_wrong_severity_word_is_caught(self):
        rep = report(interaction("moderate", "kidney_bp"))
        text = render_block(rep, EN) + "\n⚠️ Important: something"
        assert "severity_mismatch" in self.ok(rep, text)

    def test_a_nothing_found_line_without_a_basis_is_caught(self):
        rep = report(interaction("major"))
        text = render_block(rep, EN) + "\n" + TEXT[EN]["none"]
        assert "interaction_statement_unjustified" in self.ok(rep, text)

    def test_a_question_without_a_report_fails(self):
        assert self.ok(None, "x", required=True) == ["interaction_report_missing"]
        assert self.ok(None, "x", required=False) == []

    def test_stop_advice_in_the_block_or_the_whole_reply(self):
        rep = report(interaction("major"))
        text = render_block(rep, EN) + "\nPlease stop taking Warf."
        assert self.ok(rep, text) == []  # outside the block: allowed (it may be the prescription's)
        assert "stop_advice" in self.ok(rep, text, whole_reply_blocklist=True)


STOP_SAMPLES = [
    "Stop taking this",
    "please discontinue the tablet",
    "do not take Brufen",
    "don't take it",
    "avoid taking both",
    "Brufen band karo",
    "Warf mat lo",
    "ye dawai chhod do",
    "इसे बंद करें",
    "यह दवाई मत लें",
    "इसे न लें",
    "ना लें यह",
]
SAFE_SAMPLES = [
    "Please ask your doctor or pharmacist before taking these together.",
    "साथ लेने से पहले अपने डॉक्टर या फ़ार्मासिस्ट से पूछें।",
    "Take after food, for 5 days",
    "दिन में 2 बार",
    "stopwatch",
]


@pytest.mark.parametrize("text", STOP_SAMPLES)
def test_the_blocklist_catches_stop_advice(text):
    assert advice_to_stop(text)


@pytest.mark.parametrize("text", SAFE_SAMPLES)
def test_the_blocklist_leaves_normal_text_alone(text):
    assert not advice_to_stop(text)


def test_no_wording_the_bot_can_produce_ever_tells_the_user_to_stop():
    """HARD GATE: every finding kind x every effect x both languages, details view included."""
    kinds = ["major", "moderate", "minor"]
    for language, severity, effect in itertools.product((EN, HI), kinds, EFFECTS):
        finding = interaction(severity, effect)
        assert not advice_to_stop(render_finding(finding, language)), (language, severity, effect)
        assert not advice_to_stop(render_block(report(finding), language))
    for language in (EN, HI):
        for overdose in (True, False):
            assert not advice_to_stop(render_finding(duplicate(overdose=overdose), language))
        for key in TEXT[language]:
            assert not advice_to_stop(TEXT[language][key].format_map(_Blank())), (language, key)
        assert not advice_to_stop(GENERIC_EN) and not advice_to_stop(GENERIC_HI)
        details = render_details(
            [interaction("major")],
            {("ibuprofen", "warfarin"): pair("ibuprofen", "warfarin")},
            report(interaction("major")),
            language,
        )
        assert not advice_to_stop(details)
    assert set(PREFIX) == {"major", "moderate", "minor", "duplicate", "duplicate_overdose"}


class _Blank(dict):
    def __missing__(self, key):
        return "x"


def test_no_effect_phrase_contains_another_one():
    """The verifier recognises an effect by its phrase: a phrase inside another one would let a
    sentence about one effect pass as another (found by the eval in the Hindi absorption phrase)."""
    for index in (0, 1):
        phrases = {code: pair[index] for code, pair in EFFECTS.items()}
        for a, text_a in phrases.items():
            for b, text_b in phrases.items():
                assert a == b or text_a not in text_b, (a, b)
