"""Helpers for the tests that run the eval suites inside pytest (M14).

The numbers a gate is checked against live in `evals/thresholds.yaml`; tests ask the harness, they do
not repeat the thresholds.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from evals.harness import gates  # noqa: E402
from evals.harness.model import SuiteResult  # noqa: E402


def gate_failures(suite: str, metrics: dict[str, float], mode: str) -> list[str]:
    """Names of the hard gates (and missing metrics) that fail for these metrics in this mode."""
    report = gates.check(SuiteResult(suite, mode, metrics), gates.load_thresholds(), None)
    return [f"{h.metric} {h.rule} (got {h.value}) {h.why}".strip() for h in report.hard_failed]
