"""End-to-end conversation suite (CLAUDE.md §11, M14 §5).

Scripted multi-turn chats (`evals/datasets/e2e/scenarios/*.yaml`) run against the REAL gateway (webhook,
router, flows, BullMQ workers) and the REAL AI service (uvicorn, `LLM_MODE=fake`) on the docker test stack
(Postgres, Redis, MinIO). Only the WhatsApp Graph API is mocked. The runner is TypeScript
(`apps/gateway/test/e2e-conversations/`) because it drives the NestJS app in-process; this module starts it,
reads its JSON result and turns it into the same metrics / gates as every other suite.

Needs: `make test-infra-up` (or the CI service containers) and `make eval-data`. Without them the run is
reported as ABORTED, never as a pass.

Mode: `fake` only. The scenarios prove the plumbing between the services (consent, queues, reminders,
erasure, safety replies); they say nothing about model quality.
"""

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import yaml

from evals.harness import ROOT
from evals.harness.metrics import ratio
from evals.harness.model import Failure, RunContext, Suite, SuiteResult

DATASET = ROOT / "evals" / "datasets" / "e2e"
SCENARIOS = DATASET / "scenarios"
TIMEOUT_S = 1500


def scenario_names() -> list[str]:
    names: list[str] = []
    for path in sorted(SCENARIOS.glob("*.yaml")):
        names += [str(item["name"]) for item in yaml.safe_load(path.read_text(encoding="utf-8"))]
    return names


def _run_jest(results: Path, only: str | None) -> subprocess.CompletedProcess[str]:
    pnpm = shutil.which("pnpm") or "pnpm"
    env = {**os.environ, "E2E_RESULTS_FILE": str(results), "E2E_SCENARIOS_DIR": str(SCENARIOS)}
    if only:
        env["E2E_SCENARIO"] = only
    return subprocess.run(  # noqa: S603 - fixed argv, no shell
        [pnpm, "--filter", "@dawai/gateway", "run", "test:e2e-conversations"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=TIMEOUT_S,
        check=False,
    )


async def run(ctx: RunContext) -> SuiteResult:
    names = scenario_names()
    only = names[0] if ctx.limit == 1 else None  # --limit 1 = smoke run of the first scenario
    with tempfile.TemporaryDirectory() as tmp:
        results_file = Path(tmp) / "e2e.json"
        done = await asyncio.to_thread(_run_jest, results_file, only)
        if not results_file.is_file():
            tail = "\n".join((done.stdout + done.stderr).strip().splitlines()[-6:])
            return SuiteResult(
                "e2e_conversations",
                ctx.mode,
                {},
                aborted=f"the e2e runner produced no result (is `make test-infra-up` running?): {tail[-400:]}",
            )
        data: dict[str, Any] = json.loads(results_file.read_text(encoding="utf-8"))
    scenarios: list[dict[str, Any]] = data["scenarios"]
    if not scenarios:
        return SuiteResult(
            "e2e_conversations",
            ctx.mode,
            {},
            aborted="no scenario ran (infrastructure not available?)",
        )
    failed_steps = [(s["name"], step) for s in scenarios for step in s["steps"] if not step["ok"]]
    passed = sum(1 for s in scenarios if s["ok"])
    failures = [
        Failure(name, f"step {step['index']} ({step['label']})", "; ".join(step["problems"])[:80])
        for name, step in failed_steps
    ]
    steps_total = sum(len(s["steps"]) for s in scenarios)
    return SuiteResult(
        suite="e2e_conversations",
        mode=ctx.mode,
        metrics={
            "scenarios_total": float(len(scenarios)),
            "scenario_pass_rate": ratio(passed, len(scenarios)),
            "scenarios_failed": float(len(scenarios) - passed),
            "steps_failed": float(len(failed_steps)),
        },
        cases=len(scenarios),
        failures=failures,
        detail_md="\n".join(
            [
                "# Conversation scenarios",
                "",
                "| Scenario | Steps run | Result |",
                "|---|---|---|",
                *[
                    f"| {s['name']} | {len(s['steps'])} | {'pass' if s['ok'] else 'FAIL'} |"
                    for s in scenarios
                ],
                "",
                f"{steps_total} steps in total. Failing steps (with the database state and the replies seen) "
                "are listed under 'Failing examples'.",
                "",
            ]
        ),
        prompt_versions=["reply_templates (gateway i18n + AI templates)"],
        notes=[
            "The AI service ran in fake mode: this checks the plumbing between the services, not model quality."
        ],
    )


SUITE = Suite(
    name="e2e_conversations",
    description="multi-turn chats through the real gateway + AI service (fake models, mocked WhatsApp)",
    run=run,
    offline_modes=("fake",),
    dataset=DATASET,
    needs=("make test-infra-up", "make eval-data"),
)
