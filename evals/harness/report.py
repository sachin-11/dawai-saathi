"""Markdown + JSON report for one harness run."""

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from evals.harness.gates import GateReport
from evals.harness.metrics import percentile
from evals.harness.model import SuiteResult, jsonable

REPORTS = Path(__file__).resolve().parents[1] / "reports"


@dataclass(slots=True)
class Run:
    result: SuiteResult
    gates: GateReport
    dataset_hash: str
    baseline_updated: str | None  # date of the baseline compared against


def _fmt(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:.4g}" if abs(value) < 1000 else f"{value:.0f}"


def _arrow(delta: float | None) -> str:
    if delta is None or abs(delta) < 1e-9:
        return "="
    return ("▲" if delta > 0 else "▼") + f" {delta:+.4g}"


def _demote(markdown: str, levels: int = 2) -> str:
    return "\n".join(
        ("#" * levels + line if line.startswith("#") else line) for line in markdown.splitlines()
    )


def _status(run: Run) -> str:
    if run.gates.aborted:
        return "ABORTED"
    return "PASS" if run.gates.passed else "FAIL"


def run_section(run: Run) -> str:
    r, g = run.result, run.gates
    lines = [
        f"## {r.suite} ({r.mode}): {_status(run)}",
        "",
        f"- Cases: {r.cases}; dataset `{run.dataset_hash}`; "
        f"prompts: {', '.join(sorted(set(r.prompt_versions))) or '-'}",
        f"- Models: {', '.join(f'{k}={v}' for k, v in sorted(r.models.items())) or 'fake / none'}",
        f"- Cost: ${r.cost_usd:.4f}; latency p50 {percentile(r.latencies_ms, 0.5):.0f} ms, "
        f"p95 {percentile(r.latencies_ms, 0.95):.0f} ms",
        f"- Baseline: {run.baseline_updated or 'none for this mode'}",
    ]
    if g.aborted:
        lines += ["", f"**Aborted:** {g.aborted}"]
    lines += ["", "### Hard gates", "", "| Metric | Rule | Value | Result |", "|---|---|---|---|"]
    for h in g.hard:
        outcome = "pass" if h.passed else f"FAIL {h.why}".strip()
        lines.append(f"| {h.metric} | {h.rule} | {_fmt(h.value)} | {outcome} |")
    if not g.hard:
        lines.append("| - | - | - | - |")
    lines += [
        "",
        "### Soft thresholds and baseline diff",
        "",
        "| Metric | Value | Baseline | Diff | Rule | Status |",
        "|---|---|---|---|---|---|",
    ]
    for s in g.soft:
        lines.append(
            f"| {s.metric} | {_fmt(s.value)} | {_fmt(s.baseline)} | {_arrow(s.delta)} | {s.rule} | {s.status} |"
        )
    if not g.soft:
        lines.append("| - | - | - | - | - | - |")
    if r.failures:
        lines += ["", "### Failing examples (ids and short redacted snippets)", ""]
        for f in r.failures[:25]:
            snippet = f" - `{f.snippet[:80]}`" if f.snippet else ""
            lines.append(f"- `{f.case_id}`: {f.why}{snippet}")
        if len(r.failures) > 25:
            lines.append(f"- ... and {len(r.failures) - 25} more (see the JSON report)")
    if r.notes:
        lines += ["", *[f"> {note}" for note in r.notes]]
    if r.detail_md:
        lines += [
            "",
            "<details><summary>Suite detail</summary>",
            "",
            _demote(r.detail_md),
            "",
            "</details>",
        ]
    lines.append("")
    return "\n".join(lines)


def build(runs: list[Run], git_sha: str, dirty: bool, scope: str) -> tuple[str, dict[str, Any]]:
    stamp = date.today().isoformat()
    failed = [r for r in runs if not r.gates.passed]
    head = [
        f"# Eval report {stamp} ({git_sha}{'+dirty' if dirty else ''}, {scope})",
        "",
        f"**Overall: {'PASS' if not failed else 'FAIL'}**",
        "",
        "| Suite | Mode | Cases | Hard gates | Regressions | Warnings | Result |",
        "|---|---|---|---|---|---|---|",
    ]
    for run in runs:
        g = run.gates
        head.append(
            f"| {run.result.suite} | {run.result.mode} | {run.result.cases} | "
            f"{len(g.hard) - len(g.hard_failed)}/{len(g.hard)} | {len(g.regressions)} | "
            f"{len(g.warnings)} | {_status(run)} |"
        )
    head += [
        "",
        "Fake modes prove the plumbing and the safety layers, not model reading accuracy.",
        "",
    ]
    markdown = "\n".join(head) + "\n" + "\n".join(run_section(r) for r in runs)
    payload = {
        "date": stamp,
        "git_sha": git_sha,
        "dirty": dirty,
        "scope": scope,
        "passed": not failed,
        "runs": [
            {
                "suite": r.result.suite,
                "mode": r.result.mode,
                "passed": r.gates.passed,
                "aborted": r.gates.aborted,
                "cases": r.result.cases,
                "dataset_hash": r.dataset_hash,
                "prompt_versions": sorted(set(r.result.prompt_versions)),
                "models": r.result.models,
                "metrics": jsonable(r.result.metrics),
                "cost_usd": round(r.result.cost_usd, 6),
                "latency_p50_ms": round(percentile(r.result.latencies_ms, 0.5), 1),
                "latency_p95_ms": round(percentile(r.result.latencies_ms, 0.95), 1),
                "hard_gates": [
                    {"metric": h.metric, "rule": h.rule, "value": h.value, "passed": h.passed}
                    for h in r.gates.hard
                ],
                "soft": [
                    {
                        "metric": s.metric,
                        "value": s.value,
                        "baseline": s.baseline,
                        "delta": s.delta,
                        "status": s.status,
                    }
                    for s in r.gates.soft
                ],
                "failing_examples": [
                    {"id": f.case_id, "why": f.why, "snippet": f.snippet[:80]}
                    for f in r.result.failures[:100]
                ],
            }
            for r in runs
        ],
    }
    return markdown, payload


def write(markdown: str, payload: dict[str, Any], name: str, directory: Path = REPORTS) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    md_path = directory / f"{name}.md"
    md_path.write_text(markdown, encoding="utf-8")
    (directory / f"{name}.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return md_path
