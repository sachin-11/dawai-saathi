"""Threshold checks: hard gates (always fail the run) and soft thresholds (fail on regression).

`thresholds.yaml` is the only place numbers live. A hard gate whose metric is MISSING fails: a typo
or a suite that silently stopped measuring must never read as a pass.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from evals.harness.model import SuiteResult

THRESHOLDS = Path(__file__).resolve().parents[1] / "thresholds.yaml"


@dataclass(frozen=True, slots=True)
class HardResult:
    metric: str
    rule: str
    value: float | None
    passed: bool
    why: str = ""


@dataclass(frozen=True, slots=True)
class SoftResult:
    metric: str
    value: float
    baseline: float | None
    delta: float | None
    status: str  # ok | warn | regress | new
    rule: str


@dataclass(slots=True)
class GateReport:
    hard: list[HardResult]
    soft: list[SoftResult]
    aborted: str | None = None

    @property
    def passed(self) -> bool:
        return (
            self.aborted is None
            and all(h.passed for h in self.hard)
            and not any(s.status == "regress" for s in self.soft)
        )

    @property
    def hard_failed(self) -> list[HardResult]:
        return [h for h in self.hard if not h.passed]

    @property
    def regressions(self) -> list[SoftResult]:
        return [s for s in self.soft if s.status == "regress"]

    @property
    def warnings(self) -> list[SoftResult]:
        return [s for s in self.soft if s.status == "warn"]


def load_thresholds(path: Path = THRESHOLDS) -> dict[str, Any]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or "suites" not in raw:
        raise ValueError(f"{path.name}: expected a top-level 'suites' mapping")
    suites: dict[str, Any] = raw["suites"]
    return suites


def _applies(rule: dict[str, Any], mode: str) -> bool:
    modes = rule.get("modes")
    return modes is None or mode in modes


def _describe(rule: dict[str, Any]) -> str:
    for key, symbol in (("eq", "=="), ("max", "<="), ("min", ">=")):
        if key in rule:
            return f"{symbol} {rule[key]}"
    return "?"


def _hard_ok(rule: dict[str, Any], value: float) -> bool:
    eps = 1e-9
    if "eq" in rule and abs(value - float(rule["eq"])) > eps:
        return False
    if "max" in rule and value > float(rule["max"]) + eps:
        return False
    return not ("min" in rule and value < float(rule["min"]) - eps)


def check(
    result: SuiteResult,
    thresholds: dict[str, Any],
    baseline: dict[str, float] | None,
) -> GateReport:
    spec = thresholds.get(result.suite)
    if spec is None:
        raise KeyError(f"no thresholds for suite '{result.suite}' in thresholds.yaml")
    if result.aborted:
        return GateReport(hard=[], soft=[], aborted=result.aborted)

    hard: list[HardResult] = []
    for metric, rule in (spec.get("hard_gates") or {}).items():
        if not _applies(rule, result.mode):
            continue
        value = result.metrics.get(metric)
        if value is None:
            hard.append(
                HardResult(metric, _describe(rule), None, False, "metric not produced by the suite")
            )
        else:
            hard.append(HardResult(metric, _describe(rule), value, _hard_ok(rule, value)))

    soft: list[SoftResult] = []
    for metric, rule in (spec.get("soft") or {}).items():
        if not _applies(rule, result.mode) or metric not in result.metrics:
            continue
        value = result.metrics[metric]
        higher = rule.get("direction", "higher") == "higher"
        base = None if baseline is None else baseline.get(metric)
        delta = None if base is None else value - base
        status = "ok"
        if base is None:
            status = "new"
        else:
            worse_by = (base - value) if higher else (value - base)
            tol_abs = rule.get("tolerance_abs")
            tol_rel = rule.get("tolerance_rel")
            if tol_abs is not None and worse_by > float(tol_abs) + 1e-9:
                status = "regress"
            elif tol_rel is not None and worse_by > abs(base) * float(tol_rel) + 1e-9:
                status = "regress"
        if status != "regress":
            if "warn_min" in rule and value < float(rule["warn_min"]):
                status = "warn"
            if "warn_max" in rule and value > float(rule["warn_max"]):
                status = "warn"
        if "tolerance_abs" in rule:
            tolerance = f"±{rule['tolerance_abs']}"
        else:
            tolerance = f"±{float(rule.get('tolerance_rel', 0)):.0%}"
        direction = rule.get("direction", "higher")
        soft.append(
            SoftResult(metric, value, base, delta, status, f"{direction} better, {tolerance}")
        )
    return GateReport(hard=hard, soft=soft)
