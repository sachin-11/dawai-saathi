"""The interaction eval as a test (M11): `make test` and CI fail on ANY hard-gate violation."""

import asyncio
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(ROOT / "data" / "scripts"))
_SPEC = importlib.util.spec_from_file_location(
    "run_interaction_eval", ROOT / "evals" / "run_interaction_eval.py"
)
assert _SPEC and _SPEC.loader
runner = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(runner)


@pytest.fixture(scope="module")
def cases() -> list:
    return runner.load_cases()


@pytest.fixture(scope="module")
def results(cases: list) -> list:
    return asyncio.run(runner.evaluate(cases))


class TestDataset:
    def test_has_enough_varied_cases(self, cases: list) -> None:
        assert len(cases) >= 100
        categories = {c["category"] for c in cases}
        assert categories >= {
            "pair", "no_row", "combination", "duplicate", "unchecked", "stored", "question",
        }  # fmt: skip

    def test_ids_are_unique(self, cases: list) -> None:
        ids = [c["id"] for c in cases]
        assert len(ids) == len(set(ids))

    def test_covers_both_languages_and_every_severity(self, cases: list) -> None:
        assert {c["language"] for c in cases if c["category"] == "question"} == {"en", "hi"}
        severities = {
            f["severity"] for c in cases for f in c["expect"]["findings"] if f["severity"]
        }
        assert severities == {"minor", "moderate", "major"}

    def test_the_gold_has_known_pairs_duplicates_and_empty_answers(self, cases: list) -> None:
        shapes = {
            "pair": any(f["type"] == "interaction" for c in cases for f in c["expect"]["findings"]),
            "duplicate": any(
                f["type"] == "duplicate_ingredient" for c in cases for f in c["expect"]["findings"]
            ),
            "empty": any(not c["expect"]["findings"] for c in cases),
        }
        assert all(shapes.values()), shapes


class TestHardGates:
    def test_every_gate_is_zero(self, results: list) -> None:
        summary = runner.metrics(results)
        failing = {name: value for name, value in summary["gates"].items() if value != 0}
        details = [f"{r.case['id']}: {r.violations}" for r in results if r.violations]
        assert not failing, f"{failing}\n" + "\n".join(details)

    def test_there_is_no_violation_at_all(self, results: list) -> None:
        details = [f"{r.case['id']}: {r.violations}" for r in results if r.violations]
        assert not details, "\n".join(details)

    def test_recall_is_complete_and_nothing_extra_is_found(self, results: list) -> None:
        summary = runner.metrics(results)
        assert summary["pairs_found"] == summary["pairs_expected"] >= 60
        assert summary["dups_found"] == summary["dups_expected"] >= 12

    def test_the_gates_actually_fire(self, cases: list) -> None:
        """A broken checker must be caught: drop the data, and recall breaks."""
        from app.interactions.repository import InMemoryInteractionRepository

        wrong = runner.compare  # noqa: F841 - the comparison is what the gate relies on
        case = next(c for c in cases if c["id"] == "pair-01")
        empty_repo = InMemoryInteractionRepository([])
        broken = asyncio.run(runner.run_checker_case(case, empty_repo))
        assert any(v.startswith("pair_missed") for v in broken.violations)
