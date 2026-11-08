"""The prescription eval gate as a test (M7): `make test` and CI fail when a safety metric regresses.

Generates a small synthetic set into a temp folder (the images are not committed) and runs the SAME
code as `evals/run_rx_eval.py` in the two offline modes. These modes do not measure model accuracy;
they prove that the deterministic layers around the model keep their promises.
"""

import asyncio
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generator = load(ROOT / "evals" / "scripts" / "make_synthetic_rx.py", "make_synthetic_rx")
runner = load(ROOT / "evals" / "run_rx_eval.py", "run_rx_eval")


@pytest.fixture(scope="module")
def cases(tmp_path_factory: pytest.TempPathFactory) -> list:
    """Eight cases: includes scribbled-out lines (index 0 and 4) and a crossed-out decoy (0, 5)."""
    directory = tmp_path_factory.mktemp("rx")
    (directory / "images").mkdir()
    (directory / "labels").mkdir()
    import json
    import random

    for index in range(8):
        case = generator.build_case(index)
        page, _ = generator.render(case, random.Random(5000 + index))  # noqa: S311
        page.convert("RGB").save(directory / "images" / f"{case['id']}.jpg", quality=88)
        (directory / "labels" / f"{case['id']}.json").write_text(
            json.dumps(generator.label_for(case)), encoding="utf-8"
        )
    return runner.load_cases(directory)


def evaluate(cases: list, mode: str):
    results = asyncio.run(runner.evaluate(cases, mode))
    scores = runner.score(results)
    return results, scores, runner.gate_failures(scores, mode)


class TestDataset:
    def test_labels_are_valid_extractions_without_phi_fields(self, cases: list) -> None:
        assert len(cases) == 8
        from app.schemas.prescription import PrescriptionExtraction

        for case in cases:
            PrescriptionExtraction.model_validate(case.gold)  # extra keys would fail
            assert case.phi_strings and all(p not in str(case.gold) for p in case.phi_strings)

    def test_the_set_contains_unreadable_lines_and_decoys(self, cases: list) -> None:
        assert sum(len(c.unreadable_indexes) for c in cases) >= 2
        assert any(c.decoy_name for c in cases)


class TestFakeReplay:
    def test_the_perfect_replay_passes_every_safety_gate(self, cases: list) -> None:
        results, scores, failures = evaluate(cases, "fake")
        assert failures == []
        assert scores.flag.total >= 2 and scores.flag.ok == scores.flag.total
        assert scores.leaks == [] and scores.hallucinated == []
        assert all(r.error is None for r in results)

    def test_injected_model_mistakes_are_caught_by_the_deterministic_layers(
        self, cases: list
    ) -> None:
        _, scores, failures = evaluate(cases, "fake-noisy")
        assert failures == []
        # A wrong daily count is corrected from the written code, so accuracy stays perfect.
        assert scores.fields["frequency_per_day"].ok == scores.fields["frequency_per_day"].total
        # An invented medicine the model was unsure about is never shown as readable.
        assert scores.hallucinated == []

    def test_the_decoy_crossed_out_line_is_not_extracted(self, cases: list) -> None:
        _, scores, _ = evaluate(cases, "fake")
        assert not any("crossed-out" in note for note in scores.notes)


class TestTheGateItself:
    def test_a_missed_flag_a_leak_or_a_hallucination_fails_the_gate(self) -> None:
        scores = runner.Scores()
        scores.flag.add(False)
        scores.leaks.append(("rx_000", "<fake phi string>"))
        scores.hallucinated.append(("rx_000", "Invented 10"))
        failures = runner.gate_failures(scores, "fake")
        assert len(failures) == 3

    def test_real_mode_reports_hallucinations_without_gating_on_them(self) -> None:
        scores = runner.Scores()
        scores.hallucinated.append(("rx_000", "Invented 10"))
        assert runner.gate_failures(scores, "real") == []
