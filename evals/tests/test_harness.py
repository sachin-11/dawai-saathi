"""Tests of the eval harness itself (gates, baselines, planning, PR checks).

Run: `make test-evals`. They use tiny fake suites and a throw-away git repo; no model, no dataset.
"""

import json
import subprocess
from pathlib import Path

import pytest

from evals.harness import baseline, checks, gates
from evals.harness.metrics import dataset_hash, percentile, prf, ratio, wer
from evals.harness.model import Budget, BudgetExceeded, Suite, SuiteResult
from evals.harness.runner import check_manifest, plan

THRESHOLDS = {
    "demo": {
        "hard_gates": {
            "leaks": {"max": 0},
            "recall": {"eq": 1.0, "modes": ["fake"]},
            "only_real": {"max": 0, "modes": ["real"]},
        },
        "soft": {
            "accuracy": {"direction": "higher", "tolerance_abs": 0.02},
            "latency": {"direction": "lower", "tolerance_rel": 0.2},
            "f1": {"direction": "higher", "tolerance_abs": 0.0, "warn_min": 0.9},
        },
    }
}


def result(mode: str = "fake", **metrics: float) -> SuiteResult:
    return SuiteResult("demo", mode, {"leaks": 0.0, "recall": 1.0, **metrics}, cases=3)


class TestHardGates:
    def test_all_good_passes(self):
        assert gates.check(result(), THRESHOLDS, None).passed

    def test_a_violated_gate_fails_and_is_named(self):
        report = gates.check(result(leaks=1.0), THRESHOLDS, None)
        assert not report.passed and [h.metric for h in report.hard_failed] == ["leaks"]

    def test_a_missing_metric_fails_instead_of_passing_silently(self):
        broken = SuiteResult("demo", "fake", {"recall": 1.0}, cases=1)
        report = gates.check(broken, THRESHOLDS, None)
        assert not report.passed and "not produced" in report.hard_failed[0].why

    def test_rules_are_scoped_to_their_modes(self):
        report = gates.check(result("real", recall=0.5, only_real=0.0), THRESHOLDS, None)
        assert report.passed  # `recall` only applies to fake
        assert not gates.check(result("real", only_real=1.0), THRESHOLDS, None).passed

    def test_an_aborted_run_never_passes(self):
        aborted = SuiteResult("demo", "real", {}, aborted="cost cap")
        report = gates.check(aborted, THRESHOLDS, None)
        assert not report.passed and report.aborted == "cost cap"

    def test_a_suite_without_thresholds_is_an_error(self):
        with pytest.raises(KeyError):
            gates.check(SuiteResult("nothing", "fake", {}), THRESHOLDS, None)

    def test_the_committed_thresholds_cover_every_suite(self):
        from evals.harness.registry import SUITE_MODULES

        committed = gates.load_thresholds()
        assert set(committed) == set(SUITE_MODULES)
        for name, spec in committed.items():
            assert spec.get("hard_gates"), f"{name} has no hard gates"


class TestSoftThresholds:
    def test_no_baseline_is_reported_as_new_and_does_not_fail(self):
        report = gates.check(result(accuracy=0.8), THRESHOLDS, None)
        assert report.passed and {s.status for s in report.soft} == {"new"}

    def test_a_drop_within_the_tolerance_is_fine(self):
        report = gates.check(result(accuracy=0.89), THRESHOLDS, {"accuracy": 0.90})
        assert next(s for s in report.soft if s.metric == "accuracy").status == "ok"

    def test_a_drop_beyond_the_tolerance_is_a_regression(self):
        report = gates.check(result(accuracy=0.85), THRESHOLDS, {"accuracy": 0.90})
        assert not report.passed and report.regressions[0].metric == "accuracy"

    def test_relative_tolerance_for_lower_is_better_metrics(self):
        ok = gates.check(result(latency=119.0), THRESHOLDS, {"latency": 100.0})
        bad = gates.check(result(latency=125.0), THRESHOLDS, {"latency": 100.0})
        assert ok.passed and not bad.passed

    def test_an_improvement_is_never_a_regression(self):
        report = gates.check(
            result(accuracy=0.99, latency=10.0), THRESHOLDS, {"accuracy": 0.9, "latency": 100.0}
        )
        assert report.passed

    def test_warn_thresholds_warn_without_failing(self):
        report = gates.check(result(f1=0.8), THRESHOLDS, {"f1": 0.8})
        assert report.passed and [s.metric for s in report.warnings] == ["f1"]


class TestBaselines:
    def test_roundtrip_and_reason_are_stored(self, tmp_path: Path):
        path = baseline.update(
            result(accuracy=0.9), "initial baseline for the harness", "abc", "sha1", tmp_path
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["modes"]["fake"]["reason"].startswith("initial")
        assert baseline.block_for("demo", "fake", tmp_path)["metrics"]["accuracy"] == 0.9
        assert data["history"][0]["git_sha"] == "sha1"

    def test_a_missing_or_trivial_reason_is_refused(self, tmp_path: Path):
        with pytest.raises(ValueError):
            baseline.update(result(), "", "abc", "sha", tmp_path)
        with pytest.raises(ValueError):
            baseline.update(result(), "fix", "abc", "sha", tmp_path)

    def test_an_aborted_run_cannot_become_a_baseline(self, tmp_path: Path):
        with pytest.raises(ValueError):
            baseline.update(
                SuiteResult("demo", "real", {}, aborted="x"),
                "a proper reason here",
                "abc",
                "sha",
                tmp_path,
            )

    def test_history_keeps_every_update(self, tmp_path: Path):
        baseline.update(result(accuracy=0.9), "first reason text", "a", "s1", tmp_path)
        baseline.update(result(accuracy=0.95), "second reason text", "a", "s2", tmp_path)
        assert [h["reason"] for h in baseline.load("demo", tmp_path)["history"]] == [
            "first reason text",
            "second reason text",
        ]


class TestPlanningAndBudget:
    @staticmethod
    def suite(name: str, offline: tuple[str, ...], real: bool = False) -> Suite:
        async def run(ctx):  # pragma: no cover - never called
            return SuiteResult(name, ctx.mode, {})

        return Suite(name, "demo", run, offline, real)

    def test_fake_expands_to_every_offline_mode(self):
        suites = [self.suite("a", ("fake", "fake-noisy")), self.suite("b", ("rules", "fake"))]
        assert [(s.name, m) for s, m in plan(suites, "fake")] == [
            ("a", "fake"),
            ("a", "fake-noisy"),
            ("b", "rules"),
            ("b", "fake"),
        ]

    def test_real_only_runs_suites_that_support_it(self):
        suites = [self.suite("a", ("fake",), real=True), self.suite("b", ("fake",))]
        assert [(s.name, m) for s, m in plan(suites, "real")] == [("a", "real")]

    def test_a_single_unsupported_suite_is_an_error(self):
        with pytest.raises(SystemExit):
            plan([self.suite("b", ("fake",))], "real")

    def test_the_budget_aborts_when_the_cap_is_passed(self):
        budget = Budget(0.05)
        budget.add(0.04)
        with pytest.raises(BudgetExceeded):
            budget.add(0.02)

    def test_no_cap_means_no_limit(self):
        Budget(None).add(1000.0)


class TestMetricsAndDatasets:
    def test_basic_metrics(self):
        assert ratio(1, 2) == 0.5 and ratio(0, 0) == 1.0 and ratio(0, 0, empty=0.0) == 0.0
        assert prf(2, 1, 1)[2] == pytest.approx(2 / 3)
        assert percentile([10, 20, 30, 40, 50], 0.5) == 30 and percentile([], 0.9) == 0.0
        assert wer("a b c d", "a b x d") == 0.25

    def test_dataset_hash_ignores_generated_images(self, tmp_path: Path):
        (tmp_path / "labels.json").write_text("{}", encoding="utf-8")
        before = dataset_hash(tmp_path)
        (tmp_path / "page.jpg").write_bytes(b"binary")
        assert dataset_hash(tmp_path) == before
        (tmp_path / "labels.json").write_text('{"a": 1}', encoding="utf-8")
        assert dataset_hash(tmp_path) != before

    def test_real_mode_refuses_a_dataset_that_may_hold_real_phi(self, tmp_path: Path):
        async def run(ctx):  # pragma: no cover
            return SuiteResult("x", ctx.mode, {})

        suite = Suite("x", "d", run, ("fake",), True, dataset=tmp_path / "cases.jsonl")
        assert "missing" in (check_manifest(suite) or "")
        (tmp_path / "manifest.json").write_text(
            json.dumps({"contains_real_phi": True}), encoding="utf-8"
        )
        assert "contains_real_phi" in (check_manifest(suite) or "")
        (tmp_path / "manifest.json").write_text(
            json.dumps({"contains_real_phi": False}), encoding="utf-8"
        )
        assert check_manifest(suite) is None

    def test_every_committed_dataset_is_marked_synthetic(self):
        from evals.harness.registry import all_suites

        for suite in all_suites():
            assert check_manifest(suite) is None, suite.name


# ---------------------------------------------------------------- PR checks in a throw-away repository


def git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    prompts = tmp_path / checks.PROMPTS
    templates = tmp_path / checks.TEMPLATES
    prompts.mkdir(parents=True)
    templates.mkdir(parents=True)
    (prompts / "rx_extract_v1.md").write_text(
        "---\nid: rx_extract\nversion: rx_extract_v1\n---\nbody one\n", encoding="utf-8"
    )
    for lang in ("en", "hi"):
        (templates / f"{lang}.yaml").write_text(
            "version: reply_templates_v1\ntexts:\n  a: hello\n", encoding="utf-8"
        )
    (tmp_path / "evals" / "reports").mkdir(parents=True)
    (tmp_path / "evals" / "thresholds.yaml").write_text("suites: {}\n", encoding="utf-8")
    (tmp_path / "CLAUDE.md").write_text("# decisions\n", encoding="utf-8")
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "-m", "base")
    monkeypatch.setattr(checks, "ROOT", tmp_path)
    return tmp_path


class TestPromptVersionCheck:
    def test_unchanged_prompts_pass(self, repo: Path):
        assert checks.prompt_version_problems("main") == []

    def test_editing_a_prompt_in_place_is_refused(self, repo: Path):
        (repo / checks.PROMPTS / "rx_extract_v1.md").write_text(
            "---\nid: rx_extract\nversion: rx_extract_v1\n---\nCHANGED\n", encoding="utf-8"
        )
        problems = checks.prompt_version_problems("main")
        assert problems and "changed in place" in problems[0]

    def test_a_new_version_file_is_fine(self, repo: Path):
        (repo / checks.PROMPTS / "rx_extract_v2.md").write_text(
            "---\nid: rx_extract\nversion: rx_extract_v2\n---\nnew\n", encoding="utf-8"
        )
        assert checks.prompt_version_problems("main") == []

    def test_a_version_that_does_not_match_the_file_name_is_refused(self, repo: Path):
        (repo / checks.PROMPTS / "rx_extract_v2.md").write_text(
            "---\nid: rx_extract\nversion: rx_extract_v1\n---\nnew\n", encoding="utf-8"
        )
        assert any("must equal the file name" in p for p in checks.prompt_version_problems("main"))

    def test_changed_templates_need_a_new_template_version(self, repo: Path):
        for lang in ("en", "hi"):
            (repo / checks.TEMPLATES / f"{lang}.yaml").write_text(
                "version: reply_templates_v1\ntexts:\n  a: changed\n", encoding="utf-8"
            )
        assert any("bump it" in p for p in checks.prompt_version_problems("main"))
        for lang in ("en", "hi"):
            (repo / checks.TEMPLATES / f"{lang}.yaml").write_text(
                "version: reply_templates_v2\ntexts:\n  a: changed\n", encoding="utf-8"
            )
        assert checks.prompt_version_problems("main") == []


class TestEvidenceCheck:
    def test_no_risky_change_needs_no_report(self, repo: Path):
        assert checks.evidence_problems("main") == []

    def test_a_new_prompt_needs_a_real_mode_report(self, repo: Path):
        (repo / checks.PROMPTS / "rx_extract_v2.md").write_text(
            "---\nid: rx_extract\nversion: rx_extract_v2\n---\nnew\n", encoding="utf-8"
        )
        problems = checks.evidence_problems("main")
        assert problems and "real-mode rx report" in problems[0]

    def _report(self, repo: Path, mode: str, suite: str = "rx", passed: bool = True) -> None:
        (repo / "evals" / "reports" / f"r-{mode}.json").write_text(
            json.dumps({"runs": [{"suite": suite, "mode": mode, "passed": passed}]}),
            encoding="utf-8",
        )

    def test_a_passing_real_report_satisfies_it(self, repo: Path):
        (repo / checks.PROMPTS / "rx_extract_v2.md").write_text(
            "---\nid: rx_extract\nversion: rx_extract_v2\n---\nnew\n", encoding="utf-8"
        )
        self._report(repo, "fake")  # an offline report is not enough for a prompt
        assert checks.evidence_problems("main")
        self._report(repo, "real")
        assert checks.evidence_problems("main") == []

    def test_a_failing_report_does_not_count(self, repo: Path):
        (repo / checks.PROMPTS / "rx_extract_v2.md").write_text(
            "---\nid: rx_extract\nversion: rx_extract_v2\n---\nnew\n", encoding="utf-8"
        )
        self._report(repo, "real", passed=False)
        assert checks.evidence_problems("main")

    def test_threshold_changes_accept_an_offline_report(self, repo: Path):
        (repo / "evals" / "thresholds.yaml").write_text("suites: {rx: {}}\n", encoding="utf-8")
        assert checks.evidence_problems("main")
        for suite in ("emergency", "matcher", "interactions", "rx", "lab", "voice", "redteam"):
            (repo / "evals" / "reports" / f"r-{suite}.json").write_text(
                json.dumps({"runs": [{"suite": suite, "mode": "fake", "passed": True}]}),
                encoding="utf-8",
            )
        assert checks.evidence_problems("main") == []

    def test_a_decisions_log_waiver_is_the_only_override(self, repo: Path):
        (repo / checks.PROMPTS / "rx_extract_v2.md").write_text(
            "---\nid: rx_extract\nversion: rx_extract_v2\n---\nnew\n", encoding="utf-8"
        )
        assert checks.evidence_problems("main")
        (repo / "CLAUDE.md").write_text(
            "# decisions\n| 2026-11-09 | eval-waiver: keys not available yet | reason |\n",
            encoding="utf-8",
        )
        assert checks.evidence_problems("main") == []
