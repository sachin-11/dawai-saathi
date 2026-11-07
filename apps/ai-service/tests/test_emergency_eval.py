"""The emergency eval gate as a test: `make test` and CI fail when recall regresses.

Runs the SAME code as `evals/run_emergency_eval.py` on `evals/datasets/emergency/emergency.jsonl`
(rules only and rules + fake classifier; both offline). The manual full run with a real model is
described in docs/modules/M6.md.
"""

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]
RUNNER_PATH = ROOT / "evals" / "run_emergency_eval.py"
spec = importlib.util.spec_from_file_location("run_emergency_eval", RUNNER_PATH)
assert spec and spec.loader
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@pytest.fixture(scope="module")
def rows() -> list:
    return runner.load_rows()


def run(rows: list, mode: str) -> list:
    return asyncio.run(runner.evaluate(rows, mode))


class TestDataset:
    def test_has_enough_synthetic_rows_with_the_required_shape(self, rows: list) -> None:
        positives = [r for r in rows if r.expected_emergency]
        negatives = [r for r in rows if not r.expected_emergency]
        assert len(rows) >= 150 and len(positives) >= 85 and len(negatives) >= 55
        assert {r.lang for r in rows} == {"en", "hi", "hinglish"}
        for line in runner.DATASET.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            assert {"text", "lang", "expected_emergency", "expected_category"} <= row.keys()

    def test_every_category_and_language_is_covered_by_positives(self, rows: list) -> None:
        positives = [r for r in rows if r.expected_emergency]
        assert len({r.expected_category for r in positives}) == 9
        for category in {r.expected_category for r in positives}:
            assert sum(r.expected_category == category for r in positives) >= 7
        assert {r.lang for r in positives} == {"en", "hi", "hinglish"}

    def test_includes_near_misses_misspellings_and_long_messages(self, rows: list) -> None:
        assert sum(r.kind == "near_miss" for r in rows) >= 15
        assert any(len(r.text) > 600 for r in rows if r.expected_emergency)

    def test_contains_no_phone_numbers_or_emails(self, rows: list) -> None:
        from app.safety.redaction import Redactor

        redactor = Redactor()
        for row in rows:
            assert redactor.redact(row.text).entities == [], row.text[:60]


class TestRulesGate:
    def test_rules_recall_is_100_percent_on_every_row_with_a_listed_keyword(
        self, rows: list
    ) -> None:
        outcomes = run(rows, "rules")
        missed = [o.row.text for o in outcomes if o.row.tier == "rules" and not o.flagged]
        assert missed == []

    def test_no_clear_negative_is_flagged(self, rows: list) -> None:
        outcomes = run(rows, "rules")
        wrong = [o.row.text for o in outcomes if o.row.kind == "clear" and o.flagged]
        assert wrong == []

    def test_detected_categories_are_the_expected_ones(self, rows: list) -> None:
        for outcome in run(rows, "rules"):
            if outcome.row.expected_emergency and outcome.flagged:
                assert outcome.result.category.value == outcome.row.expected_category, (
                    outcome.row.text[:60]
                )

    def test_the_gate_function_agrees(self, rows: list) -> None:
        metrics = runner.metrics(run(rows, "rules"))
        assert runner.gate_failures(metrics, "rules") == []


class TestFullModeWithTheFakeClassifier:
    def test_overall_recall_is_100_percent(self, rows: list) -> None:
        outcomes = run(rows, "fake")
        missed = [o.row.text for o in outcomes if o.row.expected_emergency and not o.flagged]
        assert missed == []
        assert runner.gate_failures(runner.metrics(outcomes), "fake") == []

    def test_the_classifier_stage_really_adds_coverage(self, rows: list) -> None:
        rules_only = sum(o.flagged for o in run(rows, "rules") if o.row.expected_emergency)
        full = sum(o.flagged for o in run(rows, "fake") if o.row.expected_emergency)
        assert full > rules_only


class TestGateLogic:
    def test_a_missed_keyword_row_fails_the_gate(self, rows: list) -> None:
        outcomes = run(rows, "rules")
        victim = next(o for o in outcomes if o.row.tier == "rules")
        victim.result = type(victim.result)(is_emergency=False)
        failures = runner.gate_failures(runner.metrics(outcomes), "rules")
        assert failures and "100%" in failures[0]

    def test_a_flagged_clear_negative_fails_the_gate(self, rows: list) -> None:
        outcomes = run(rows, "rules")
        clear = next(o for o in outcomes if o.row.kind == "clear")
        clear.result = type(clear.result)(is_emergency=True)
        assert runner.gate_failures(runner.metrics(outcomes), "rules")

    def test_the_report_names_the_gate_result_and_sections(self, rows: list) -> None:
        outcomes = run(rows, "rules")
        text = runner.report(outcomes, "rules", [])
        for heading in ("Recall per language", "Recall per category", "Near misses"):
            assert heading in text
        assert "Gate: PASS" in text
