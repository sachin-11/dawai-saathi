"""Command line: `python -m evals.harness.cli <run|baseline|summary|list|check-datasets|check-prompts|check-evidence>`.

Run it from the repo root through the AI service environment (the Makefile does this):

  uv run --project apps/ai-service python -m evals.harness.cli run --mode fake
"""

import argparse
import json
import os
import re
import sys

from evals.harness import ROOT, baseline, checks
from evals.harness.model import OFFLINE, Suite
from evals.harness.registry import SUITE_MODULES, all_suites, load_suite
from evals.harness.report import REPORTS, Run, build, write
from evals.harness.runner import check_manifest, git_info, run_sync

README = ROOT / "README.md"
MARK_START = "<!-- eval-summary:start -->"
MARK_END = "<!-- eval-summary:end -->"


def _suites(arg: str | None) -> list[Suite]:
    if not arg or arg == "all":
        return all_suites()
    return [load_suite(name.strip()) for name in arg.split(",") if name.strip()]


def _print_runs(runs: list[Run]) -> None:
    for run in runs:
        g = run.gates
        status = "ABORTED" if g.aborted else ("PASS" if g.passed else "FAIL")
        print(f"[{status}] {run.result.suite}/{run.result.mode}: {run.result.cases} cases")
        if g.aborted:
            print(f"    aborted: {g.aborted}")
        for h in g.hard_failed:
            print(f"    HARD GATE {h.metric} {h.rule}: got {h.value} {h.why}")
        for s in g.regressions:
            print(f"    REGRESSION {s.metric}: {s.baseline} -> {s.value} ({s.rule})")
        for s in g.warnings:
            print(f"    warning {s.metric}: {s.value}")


def cmd_run(args: argparse.Namespace) -> int:
    suites = _suites(args.suite)
    max_usd = args.max_usd if args.max_usd is not None else _env_float("EVAL_MAX_USD")
    if args.mode == "real" and max_usd is None:
        print("real mode needs a cost cap: pass --max-usd or set EVAL_MAX_USD", file=sys.stderr)
        return 2
    runs = run_sync(suites, args.mode, limit=args.limit, max_usd=max_usd, language=args.language)
    if not runs:
        print("nothing to run for this suite/mode combination", file=sys.stderr)
        return 2
    _print_runs(runs)
    if not args.no_report:
        sha, dirty = git_info()
        scope = (
            "all suites" if len(suites) == len(SUITE_MODULES) else ",".join(s.name for s in suites)
        )
        markdown, payload = build(runs, sha, dirty, f"{scope}, mode {args.mode}")
        suffix = (
            ""
            if args.mode == OFFLINE and len(suites) == len(SUITE_MODULES)
            else f"-{_slug(scope)}-{args.mode}"
        )
        path = write(markdown, payload, f"{payload['date']}-{sha}{suffix}")
        print(f"report: {path.relative_to(ROOT)} (+ .json)")
    return 0 if all(r.gates.passed for r in runs) else 1


def cmd_baseline(args: argparse.Namespace) -> int:
    if not args.reason:
        print(
            "--reason is required: say WHY the baseline moves (it goes into the Decisions Log)",
            file=sys.stderr,
        )
        return 2
    suites = _suites(args.suite)
    runs = run_sync(suites, args.mode, limit=None, max_usd=_env_float("EVAL_MAX_USD"))
    sha, _ = git_info()
    for run in runs:
        if run.gates.hard_failed or run.gates.aborted:
            print(
                f"refusing to baseline {run.result.suite}/{run.result.mode}: hard gates fail or run aborted",
                file=sys.stderr,
            )
            return 1
    for run in runs:
        path = baseline.update(run.result, args.reason, run.dataset_hash, sha)
        print(f"baseline written: {path.relative_to(ROOT)} [{run.result.mode}]")
    print("Now add a Decisions Log entry in CLAUDE.md §15 with this reason.")
    return 0


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40]


def _env_float(name: str) -> float | None:
    raw = os.environ.get(name)
    return float(raw) if raw else None


def cmd_list(_: argparse.Namespace) -> int:
    for suite in all_suites():
        real = f", real (~${suite.est_real_cost_usd:.2f})" if suite.real_mode else ""
        print(
            f"{suite.name:18} offline: {', '.join(suite.offline_modes)}{real} - {suite.description}"
        )
    return 0


def cmd_check_datasets(_: argparse.Namespace) -> int:
    bad = [(s.name, p) for s in all_suites() if (p := check_manifest(s))]
    for name, problem in bad:
        print(f"{name}: {problem}", file=sys.stderr)
    return 1 if bad else 0


def latest_full_report() -> dict[str, object] | None:
    candidates = sorted(REPORTS.glob("*.json"))
    for path in reversed(candidates):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("scope", "").startswith("all suites") and data["scope"].endswith("mode fake"):
            return dict(data)
    return None


def cmd_summary(_: argparse.Namespace) -> int:
    data = latest_full_report()
    if data is None:
        print("no full fake-mode report found: run `make eval` first", file=sys.stderr)
        return 1
    rows = [
        "| Suite | Mode | Cases | Hard gates | Result | Key metric |",
        "|---|---|---|---|---|---|",
    ]
    for run in data["runs"]:  # type: ignore[attr-defined]
        gates_ok = sum(1 for g in run["hard_gates"] if g["passed"])
        key = _key_metric(run)
        rows.append(
            f"| {run['suite']} | {run['mode']} | {run['cases']} | {gates_ok}/{len(run['hard_gates'])} | "
            f"{'PASS' if run['passed'] else 'FAIL'} | {key} |"
        )
    table = "\n".join(
        [
            f"_Latest full offline run: {data['date']} at `{data['git_sha']}`. Fake modes check the "
            "plumbing and the safety layers, not model reading accuracy; real-mode numbers are not "
            "in this table._",
            "",
            *rows,
        ]
    )
    text = README.read_text(encoding="utf-8")
    if MARK_START not in text or MARK_END not in text:
        print(f"README.md has no {MARK_START} ... {MARK_END} markers", file=sys.stderr)
        return 1
    before, rest = text.split(MARK_START, 1)
    _, after = rest.split(MARK_END, 1)
    README.write_text(f"{before}{MARK_START}\n{table}\n{MARK_END}{after}", encoding="utf-8")
    print("README.md eval summary updated")
    return 0


_KEY_METRICS = {
    "emergency": "recall_rules_tier",
    "matcher": "correct_product_rate",
    "interactions": "pair_recall",
    "rx": "field_name_exact",
    "lab": "critical_recall",
    "voice": "emergency_recall_voice",
    "redteam": "assertion_pass_rate",
    "readability": "readability_mean",
    "e2e_conversations": "scenario_pass_rate",
}


def _key_metric(run: dict[str, object]) -> str:
    name = _KEY_METRICS.get(str(run["suite"]))
    metrics: dict[str, float] = run["metrics"]  # type: ignore[assignment]
    if name and name in metrics:
        value = metrics[name]
        return f"{name} {value:.2f}" if value > 1.0 else f"{name} {value:.1%}"
    return "-"


def cmd_check_prompts(args: argparse.Namespace) -> int:
    problems = checks.prompt_version_problems(args.base)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


def cmd_check_evidence(args: argparse.Namespace) -> int:
    problems = checks.evidence_problems(args.base)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run suites, apply gates, write the report")
    run.add_argument("--suite", help="comma separated suite names (default: all)")
    run.add_argument(
        "--mode", default=OFFLINE, help="fake (every offline mode), fake-noisy, rules, real"
    )
    run.add_argument("--limit", type=int, default=None)
    run.add_argument("--language", choices=("en", "hi"), default="en")
    run.add_argument(
        "--max-usd", type=float, default=None, help="real mode cost cap (or EVAL_MAX_USD)"
    )
    run.add_argument("--no-report", action="store_true")
    run.set_defaults(func=cmd_run)

    base = sub.add_parser(
        "baseline", help="store the current metrics as the baseline (needs --reason)"
    )
    base.add_argument("--suite", required=True)
    base.add_argument("--mode", default=OFFLINE)
    base.add_argument("--reason", default="")
    base.set_defaults(func=cmd_baseline)

    sub.add_parser("list", help="list suites").set_defaults(func=cmd_list)
    sub.add_parser(
        "check-datasets", help="every dataset manifest says contains_real_phi: false"
    ).set_defaults(func=cmd_check_datasets)
    sub.add_parser("summary", help="write the latest results into README.md").set_defaults(
        func=cmd_summary
    )

    prompts = sub.add_parser("check-prompts", help="a changed prompt file must have a new version")
    prompts.add_argument("--base", default="origin/main")
    prompts.set_defaults(func=cmd_check_prompts)

    evidence = sub.add_parser("check-evidence", help="risky changes need an updated eval report")
    evidence.add_argument("--base", default="origin/main")
    evidence.set_defaults(func=cmd_check_evidence)

    args = parser.parse_args(argv)
    code: int = args.func(args)
    return code


if __name__ == "__main__":
    sys.exit(main())
