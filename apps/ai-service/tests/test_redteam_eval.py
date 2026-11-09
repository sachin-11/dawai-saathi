"""The red-team and readability suites as tests (M14): the gates hold AND they can fail.

The second half matters as much as the first: a suite that cannot fail proves nothing, so each safety layer
is switched off in turn and the matching gate must go red.
"""

import asyncio
import importlib.util
from pathlib import Path

import pytest
from evals.harness.model import RunContext
from evals.suites import readability, redteam

from tests.eval_support import gate_failures

ROOT = Path(__file__).parents[3]


@pytest.fixture(scope="module", autouse=True)
def images() -> None:
    """The red-team images are generated, not committed."""
    spec = importlib.util.spec_from_file_location(
        "make_synthetic_redteam", ROOT / "evals" / "scripts" / "make_synthetic_redteam.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.main()


def run_redteam() -> dict[str, float]:
    return asyncio.run(redteam.run(RunContext(mode="fake"))).metrics


def test_every_redteam_gate_is_zero():
    metrics = run_redteam()
    assert gate_failures("redteam", metrics, "fake") == []
    assert metrics["assertion_pass_rate"] == 1.0


def test_the_dataset_covers_every_attack_family():
    categories = {c.category for c in redteam.load_cases()}
    assert categories >= {
        "text_injection", "image_injection", "self_harm", "overdose", "dose_change",
        "controlled", "phi_exfiltration", "garbage", "garbage_image",
    }  # fmt: skip
    assert len(redteam.load_cases()) >= 60


def test_switching_off_the_injection_guard_turns_the_gate_red(monkeypatch: pytest.MonkeyPatch):
    import app.tools.lab_normalize as lab_normalize
    import app.tools.rx_validate as rx_validate

    monkeypatch.setattr(rx_validate, "looks_like_instruction", lambda *a, **k: False)
    monkeypatch.setattr(lab_normalize, "looks_like_instruction", lambda *a, **k: False)
    failures = gate_failures("redteam", run_redteam(), "fake")
    assert any("injection_followed" in f or "assertion_pass_rate" in f for f in failures)


def test_removing_the_overdose_keywords_turns_the_gate_red(monkeypatch: pytest.MonkeyPatch):
    from app.safety import emergency_guard

    real = emergency_guard.EmergencyGuard.check_rules

    def blind(self, text):  # the rules stage sees nothing: only the classifier stage is left
        return emergency_guard.EmergencyResult(is_emergency=False)

    monkeypatch.setattr(emergency_guard.EmergencyGuard, "check_rules", blind)
    failures = gate_failures("redteam", run_redteam(), "fake")
    assert any("emergency_missed" in f for f in failures)
    assert real is not blind


def test_the_readability_suite_reports_agreement_and_never_gates_safety():
    result = asyncio.run(readability.run(RunContext(mode="fake")))
    assert result.metrics["validation_examples"] == 30
    assert 0.0 <= result.metrics["judge_human_within_one"] <= 1.0
    assert result.metrics["judge_errors"] == 0
    assert gate_failures("readability", result.metrics, "fake") == []
