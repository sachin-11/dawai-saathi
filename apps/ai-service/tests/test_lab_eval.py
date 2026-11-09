"""The lab eval gate as a test (M12): `make test` and CI fail when a safety metric regresses.

Generates a small synthetic set into a temp folder (the images are not committed) and runs the SAME
code as the `lab` eval suite in the two offline modes. They do not measure model accuracy; they prove
that the deterministic layers around the model keep their promises: every critical value is raised, no
diagnosis wording, no number that is not on the page, no PHI.
"""

import asyncio
import importlib.util
import json
import random
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


from tests.eval_support import gate_failures  # noqa: E402

generator = load(ROOT / "evals" / "scripts" / "make_synthetic_lab.py", "make_synthetic_lab")
from evals.suites import lab as runner  # noqa: E402

COUNT = 12  # includes 4 reports with a critical value and one multi-page PDF


@pytest.fixture(scope="module")
def cases(tmp_path_factory: pytest.TempPathFactory) -> list:
    directory = tmp_path_factory.mktemp("lab")
    (directory / "images").mkdir()
    (directory / "labels").mkdir()
    for index in range(COUNT):
        case = generator.build_case(index)
        rng = random.Random(9000 + index)  # noqa: S311
        for number, page in enumerate(generator.render(case, rng), start=1):
            page.save(directory / "images" / f"{case['id']}_p{number}.jpg", quality=85)
        label = {
            k: v
            for k, v in case.items()
            if k not in ("patient", "patient_id", "sample_id", "phone")
        }
        (directory / "labels" / f"{case['id']}.json").write_text(
            json.dumps(label, ensure_ascii=False), encoding="utf-8"
        )
    return runner.load_cases(directory)


def test_the_dataset_has_critical_values_and_a_multi_page_report(cases):
    assert len(cases) == COUNT
    assert sum(r["critical"] for c in cases for r in c.label["results"]) >= 3
    assert any(len(c.pages) > 1 for c in cases)
    assert any(r["test_code"] is None for c in cases for r in c.label["results"])


@pytest.mark.parametrize("mode", ["fake", "fake-noisy"])
@pytest.mark.parametrize("language", ["en", "hi"])
def test_every_hard_gate_is_zero(cases, mode, language):
    results = asyncio.run(runner.evaluate(cases, mode, language))
    scores = runner.score(results, language)
    assert gate_failures("lab", runner.to_metrics([(results, scores)]), mode) == []
    assert scores.critical.total >= 3 and scores.critical.ok == scores.critical.total
    assert scores.errors == 0


def test_a_perfect_replay_is_scored_perfectly(cases):
    results = asyncio.run(runner.evaluate(cases, "fake"))
    scores = runner.score(results)
    for tally in (scores.mapping, scores.value_unit, scores.printed_range, scores.status):
        assert tally.total > 0 and tally.ok == tally.total, tally.pct()


def test_the_gate_really_fails_when_a_critical_value_is_missed(cases):
    results = asyncio.run(runner.evaluate(cases, "fake"))
    victim = next(r for r in results if any(x["critical"] for x in r.case.label["results"]))
    extraction = victim.output.extraction
    tampered = [
        x.model_copy(update={"status": "normal"}) if x.status.startswith("critical") else x
        for x in extraction.results
    ]
    victim.output = victim.output.__class__(
        intent=victim.output.intent,
        emergency=False,
        reply=victim.output.reply,
        extraction=extraction.model_copy(update={"results": tampered}),
    )
    failures = gate_failures("lab", runner.to_metrics([(results, runner.score(results))]), "fake")
    assert any("critical_recall" in f for f in failures)
