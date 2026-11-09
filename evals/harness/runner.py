"""Run suites, collect results, apply gates."""

import asyncio
import json
import subprocess
import time
from pathlib import Path
from typing import Any

from app.observability.logging import configure_logging
from evals.harness import ROOT, baseline, gates
from evals.harness.metrics import dataset_hash, percentile
from evals.harness.model import (
    OFFLINE,
    Budget,
    BudgetExceeded,
    RunContext,
    Suite,
    SuiteResult,
)
from evals.harness.report import Run


def git_info() -> tuple[str, bool]:
    def run(*args: str) -> str:
        return subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["git", *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        ).stdout.strip()

    sha = run("rev-parse", "--short", "HEAD") or "nogit"
    return sha, bool(run("status", "--porcelain", "--", "evals", "apps"))


def plan(suites: list[Suite], mode: str) -> list[tuple[Suite, str]]:
    """`fake` = every offline mode a suite declares; any other value must be supported by the suite."""
    out: list[tuple[Suite, str]] = []
    for suite in suites:
        if mode == OFFLINE:
            out.extend((suite, m) for m in suite.offline_modes)
        elif suite.supports(mode):
            out.append((suite, mode))
        elif len(suites) == 1:
            raise SystemExit(f"suite '{suite.name}' has no mode '{mode}'")
    return out


def manifest_for(suite: Suite) -> Path | None:
    if suite.dataset is None:
        return None
    directory = suite.dataset if suite.dataset.is_dir() else suite.dataset.parent
    return directory / "manifest.json"


def check_manifest(suite: Suite) -> str | None:
    """Real mode sends datasets to a provider: only synthetic / anonymised sets may go (CLAUDE.md §5.5)."""
    path = manifest_for(suite)
    if path is None:
        return None
    shown = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    if not path.is_file():
        return f"{shown} is missing"
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    if data.get("contains_real_phi") is not False:
        return f"{shown}: contains_real_phi must be false"
    return None


async def run_suite(
    suite: Suite, mode: str, *, limit: int | None, max_usd: float | None, language: str = "en"
) -> SuiteResult:
    ctx = RunContext(
        mode=mode,
        limit=limit,
        concurrency=1,  # sequential on purpose: predictable cost; retries live in the LLM router
        budget=Budget(max_usd),
        language=language,
    )
    if mode == "real":
        problem = check_manifest(suite)
        if problem:
            return SuiteResult(suite.name, mode, {}, aborted=f"dataset manifest: {problem}")
    configure_logging(
        "silent"
    )  # per-call model logs would drown the report (a suite may install a Tap)
    started = time.perf_counter()
    try:
        result = await suite.run(ctx)
    except BudgetExceeded as error:
        return SuiteResult(suite.name, mode, {}, aborted=str(error))
    except FileNotFoundError as error:
        hint = f" (needs: {', '.join(suite.needs)})" if suite.needs else ""
        return SuiteResult(suite.name, mode, {}, aborted=f"missing input {error.filename}{hint}")
    result.metrics.setdefault("duration_s", time.perf_counter() - started)
    if result.latencies_ms:
        result.metrics["latency_p50_ms"] = percentile(result.latencies_ms, 0.5)
        result.metrics["latency_p95_ms"] = percentile(result.latencies_ms, 0.95)
    result.metrics["cost_usd_total"] = result.cost_usd
    result.metrics["cost_per_case_usd"] = result.cost_usd / max(result.cases, 1)
    return result


def evaluate_run(suite: Suite, result: SuiteResult) -> Run:
    block = baseline.block_for(suite.name, result.mode)
    thresholds = gates.load_thresholds()
    report = gates.check(result, thresholds, None if block is None else block["metrics"])
    return Run(
        result=result,
        gates=report,
        dataset_hash=dataset_hash(suite.dataset),
        baseline_updated=None if block is None else f"{block['updated']} ({block['git_sha']})",
    )


async def run_all(
    suites: list[Suite],
    mode: str,
    *,
    limit: int | None,
    max_usd: float | None,
    language: str = "en",
) -> list[Run]:
    runs: list[Run] = []
    spent = 0.0
    for suite, suite_mode in plan(suites, mode):
        remaining = None if max_usd is None else max(max_usd - spent, 0.0)
        result = await run_suite(
            suite, suite_mode, limit=limit, max_usd=remaining, language=language
        )
        spent += result.cost_usd
        runs.append(evaluate_run(suite, result))
    return runs


def run_sync(*args: Any, **kwargs: Any) -> list[Run]:
    return asyncio.run(run_all(*args, **kwargs))
