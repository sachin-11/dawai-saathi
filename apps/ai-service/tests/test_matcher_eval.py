"""The matcher/finder eval as a test (M8): `make test` and CI fail on ANY hard-gate violation."""

import asyncio
import importlib.util
import json
from pathlib import Path
from typing import ClassVar

import pytest
from evals.suites import matcher as runner

from tests.catalog_support import row
from tests.eval_support import gate_failures

ROOT = Path(__file__).parents[3]


@pytest.fixture(scope="module")
def cases() -> list:
    return runner.load_cases()


@pytest.fixture(scope="module")
def results(cases: list) -> list:
    return asyncio.run(runner.evaluate(cases))


class TestDataset:
    def test_has_enough_varied_cases(self, cases: list) -> None:
        assert len(cases) >= 150
        categories = {c["category"] for c in cases}
        assert categories >= {
            "brand_exact", "brand_squeezed", "brand_typo", "devanagari", "salt_written",
            "wrong_strength", "wrong_form", "strength_unverified", "release", "unknown",
        }  # fmt: skip
        assert sum(c["excluded"] for c in cases) >= 40  # NTI, insulin, inhaler, modified release

    def test_every_case_has_the_required_shape(self, cases: list) -> None:
        for case in cases:
            assert {
                "id",
                "category",
                "name",
                "strength",
                "form",
                "gold",
                "excluded",
                "forbid_suggestion",
                "expect_suggestion",
            } <= case.keys()
            if case["gold"] is not None:
                assert set(case["gold"]) == {"salt_key", "strength_key", "form_key", "release_type"}

    def test_the_committed_file_matches_the_builder(self) -> None:
        spec = importlib.util.spec_from_file_location(
            "build_dataset", ROOT / "evals" / "datasets" / "drug_matching" / "build_dataset.py"
        )
        assert spec and spec.loader
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        committed = [
            json.loads(line) for line in runner.DATASET.read_text(encoding="utf-8").splitlines()
        ]
        rebuilt = [{"id": f"dm_{i:03d}", **r} for i, r in enumerate(builder.build())]
        assert committed == rebuilt, (
            "run evals/datasets/drug_matching/build_dataset.py and commit the result"
        )


class TestHardGates:
    def test_every_gate_is_zero(self, results: list) -> None:
        m = runner.metrics(results)
        assert gate_failures("matcher", runner.to_metrics(results, m), "fake") == [], m["gates"]
        assert m["gates"] == dict.fromkeys(runner.GATES, 0)

    def test_no_wrong_product_and_no_false_match_on_unknown_names(self, results: list) -> None:
        m = runner.metrics(results)
        assert m["wrong"] == [] and m["false_matches"] == []

    def test_unsafe_inputs_never_get_a_suggestion(self, results: list) -> None:
        m = runner.metrics(results)
        assert m["guarded_total"] >= 15 and m["guarded_suggested"] == 0

    def test_excluded_drugs_never_get_a_suggestion(self, results: list) -> None:
        excluded = [r for r in results if r.case["excluded"]]
        assert len(excluded) >= 40 and all(not r.alternatives for r in excluded)

    def test_the_safe_generics_that_exist_are_mostly_found(self, results: list) -> None:
        m = runner.metrics(results)
        assert m["expected_given"] / m["expected_total"] >= 0.7  # utility floor, not a safety gate


class TestTheGatesDetectViolations:
    """The gate is only worth something if it fails when a wrong suggestion appears."""

    GOLD: ClassVar[dict[str, str]] = {
        "salt_key": "paracetamol",
        "strength_key": "650mg",
        "form_key": "tablet",
        "release_type": "ir",
    }

    def case(self, **kw):
        base = {"gold": self.GOLD, "forbid_suggestion": False, "excluded": False}
        return base | kw

    def test_a_clean_suggestion_has_no_violation(self) -> None:
        assert runner.violations(self.case(), [row()]) == []

    @pytest.mark.parametrize(
        ("alternative", "expected"),
        [
            (row(strength_key="500mg"), "wrong_strength"),
            (row(form_key="syrup"), "wrong_form_release"),
            (row(release_type="sr"), "wrong_form_release"),
            (row(salt_key="ibuprofen"), "wrong_salt"),
        ],
    )
    def test_a_wrong_alternative_is_counted(self, alternative, expected) -> None:
        assert expected in runner.violations(self.case(), [alternative])

    def test_any_suggestion_for_an_excluded_or_forbidden_or_unknown_case_is_a_violation(
        self,
    ) -> None:
        for kw in ({"excluded": True}, {"forbid_suggestion": True}, {"gold": None}):
            assert runner.violations(self.case(**kw), [row()]) == ["forbidden_suggestion"]

    def test_the_gate_fails_when_a_violation_is_present(self, results: list) -> None:
        tampered = list(results)
        victim = next(r for r in tampered if r.case["excluded"])
        poisoned = type(victim)(
            victim.case,
            victim.method,
            victim.matched,
            victim.outcome,
            [row()],
            ["forbidden_suggestion"],
        )
        tampered[tampered.index(victim)] = poisoned
        assert (
            gate_failures("matcher", runner.to_metrics(tampered, runner.metrics(tampered)), "fake")
            != []
        )
