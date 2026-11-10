"""Emergency-detection suite (CLAUDE.md §11): recall must be 100%.

Modes
  rules  the keyword rules only (offline, deterministic)
  fake   rules + the classifier stage with the FAKE provider (checks the plumbing; its keyword hints
         stand in for a model on the "classifier tier" rows)
  real   rules + the classifier stage with the REAL provider from your environment / .env

"Near miss" negatives (a symptom or medicine mentioned without a current danger) are flagged ON
PURPOSE by the rules (safety first, no negation handling): they are counted and listed, not gated.
Gates live in evals/thresholds.yaml.
"""

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings, load_settings  # noqa: E402
from app.llm.factory import build_llm_router  # noqa: E402
from app.observability.logging import configure_logging  # noqa: E402
from app.pipeline.base import RequestUsage  # noqa: E402
from app.prompts.registry import PromptRegistry  # noqa: E402
from app.safety.emergency_guard import (  # noqa: E402
    CLASSIFIER_PROMPT_ID,
    EmergencyGuard,
    EmergencyResult,
    UserText,
    load_keyword_index,
)
from evals.harness import ROOT
from evals.harness.metrics import ratio
from evals.harness.model import Failure, RunContext, Suite, SuiteResult

DATASET = ROOT / "evals" / "datasets" / "emergency" / "emergency.jsonl"


@dataclass(frozen=True, slots=True)
class Row:
    text: str
    lang: str
    expected_emergency: bool
    expected_category: str | None
    tier: str | None
    kind: str | None


@dataclass(slots=True)
class Outcome:
    row: Row
    result: EmergencyResult

    @property
    def flagged(self) -> bool:
        return self.result.is_emergency


def load_rows(path: Path = DATASET) -> list[Row]:
    rows: list[Row] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        raw = json.loads(line)
        rows.append(
            Row(
                text=raw["text"],
                lang=raw["lang"],
                expected_emergency=raw["expected_emergency"],
                expected_category=raw.get("expected_category"),
                tier=raw.get("tier"),
                kind=raw.get("kind"),
            )
        )
    return rows


def make_settings(mode: str) -> Settings:
    if mode == "real":
        return load_settings()  # your .env / environment
    return load_settings(
        _env_file=None,
        NODE_ENV="test",
        LOG_LEVEL="silent",
        SERVICE_TOKEN="eval-token-not-secret",
        DATABASE_URL="postgresql://eval:eval@127.0.0.1:1/eval",
        LLM_MODE="fake",
    )


async def evaluate(rows: list[Row], mode: str) -> list[Outcome]:
    guard = EmergencyGuard()
    settings = make_settings(mode)
    router = build_llm_router(settings) if mode != "rules" else None
    prompts = PromptRegistry()
    outcomes: list[Outcome] = []
    for row in rows:
        text = UserText(row.text)
        result = guard.check_rules(text)
        if not result.is_emergency and router is not None:
            result = await guard.classify(
                row.text, router=router, prompts=prompts, settings=settings, usage=RequestUsage()
            )
        outcomes.append(Outcome(row, result))
    return outcomes


def pct(numerator: int, denominator: int) -> str:
    return (
        "n/a"
        if denominator == 0
        else f"{100 * numerator / denominator:.1f}% ({numerator}/{denominator})"
    )


def metrics(outcomes: list[Outcome]) -> dict[str, Any]:
    positives = [o for o in outcomes if o.row.expected_emergency]
    negatives = [o for o in outcomes if not o.row.expected_emergency]
    clear = [o for o in negatives if o.row.kind == "clear"]
    near = [o for o in negatives if o.row.kind == "near_miss"]
    rules_tier = [o for o in positives if o.row.tier == "rules"]
    true_pos = sum(o.flagged for o in positives)
    false_pos = sum(o.flagged for o in negatives)
    return {
        "positives": positives,
        "negatives": negatives,
        "clear": clear,
        "near": near,
        "rules_tier": rules_tier,
        "recall": (true_pos, len(positives)),
        "recall_rules_tier": (sum(o.flagged for o in rules_tier), len(rules_tier)),
        "precision": (true_pos, true_pos + false_pos),
        "fpr_all": (false_pos, len(negatives)),
        "fpr_clear": (sum(o.flagged for o in clear), len(clear)),
        "near_flagged": (sum(o.flagged for o in near), len(near)),
        "category_correct": (
            sum(
                bool(
                    o.flagged
                    and o.result.category
                    and o.result.category.value == o.row.expected_category
                )
                for o in positives
            ),
            true_pos,
        ),
    }


def per_group(outcomes: list[Outcome], key: str) -> dict[str, tuple[int, int]]:
    groups: dict[str, list[Outcome]] = defaultdict(list)
    for outcome in outcomes:
        if outcome.row.expected_emergency:
            groups[
                getattr(outcome.row, key)
                if key != "category"
                else outcome.row.expected_category or "-"
            ].append(outcome)
    return {
        name: (sum(o.flagged for o in items), len(items)) for name, items in sorted(groups.items())
    }


def report(outcomes: list[Outcome], mode: str) -> str:
    m = metrics(outcomes)
    index = load_keyword_index()
    lines = [
        f"# Emergency detection eval ({mode} mode)",
        "",
        f"- Keyword file: `{index.version}`; classifier prompt: `{CLASSIFIER_PROMPT_ID}`",
        f"- Rows: {len(outcomes)} ({len(m['positives'])} positives, {len(m['negatives'])} negatives)",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Recall (all positives) | {pct(*m['recall'])} |",
        f"| Recall, rows with a listed keyword (tier rules) | {pct(*m['recall_rules_tier'])} |",
        f"| Category correct among detected | {pct(*m['category_correct'])} |",
        f"| Precision | {pct(*m['precision'])} |",
        f"| False-positive rate, clear negatives | {pct(*m['fpr_clear'])} |",
        f"| Near misses flagged (expected: safety first) | {pct(*m['near_flagged'])} |",
        f"| False-positive rate, all negatives | {pct(*m['fpr_all'])} |",
        "",
        "## Recall per language",
        "",
        "| Language | Recall |",
        "|---|---|",
        *[f"| {name} | {pct(*value)} |" for name, value in per_group(outcomes, "lang").items()],
        "",
        "## Recall per category",
        "",
        "| Category | Recall |",
        "|---|---|",
        *[f"| {name} | {pct(*value)} |" for name, value in per_group(outcomes, "category").items()],
        "",
        "## Missed positives",
        "",
    ]
    missed = [o for o in m["positives"] if not o.flagged]
    lines += [f"- ({o.row.lang}, {o.row.tier}) {o.row.text[:120]}" for o in missed] or ["None."]
    lines += ["", "## Clear negatives that were flagged", ""]
    wrong = [o for o in m["clear"] if o.flagged]
    lines += [f"- ({o.row.lang}) {o.row.text}" for o in wrong] or ["None."]
    lines += ["", "## Near misses (flagged on purpose: no negation or history handling)", ""]
    lines += [
        f"- {'FLAGGED' if o.flagged else 'not flagged'}: ({o.row.lang}) {o.row.text}"
        for o in m["near"]
    ]
    lines += [
        "",
        'Dataset rows are synthetic. Overdose questions ("overdose kitne mg par hota hai") are positives by '
        "policy: the user gets 112/108 guidance only, never a dose.",
        "",
    ]
    return "\n".join(lines)


def to_metrics(outcomes: list[Outcome]) -> dict[str, float]:
    m = metrics(outcomes)

    def r(key: str) -> float:
        return ratio(*m[key])

    return {
        "recall": r("recall"),
        "recall_rules_tier": r("recall_rules_tier"),
        "false_positive_rate_clear": ratio(*m["fpr_clear"], empty=0.0),
        "precision": r("precision"),
        "category_accuracy": r("category_correct"),
        "near_miss_flag_rate": ratio(*m["near_flagged"], empty=0.0),
        "missed_positives": float(len(m["positives"]) - m["recall"][0]),
        "clear_negatives_flagged": float(m["fpr_clear"][0]),
    }


async def run(ctx: RunContext) -> SuiteResult:
    configure_logging("silent")  # per-call model logs would drown the report
    rows = load_rows()
    if ctx.limit:
        rows = rows[: ctx.limit]
    outcomes = await evaluate(rows, ctx.mode)
    m = metrics(outcomes)
    failures = [
        Failure(f"{o.row.lang}:{o.row.tier or '-'}", "emergency not detected", o.row.text[:60])
        for o in m["positives"]
        if not o.flagged
    ] + [
        Failure(f"{o.row.lang}:clear", "clear negative flagged", o.row.text[:60])
        for o in m["clear"]
        if o.flagged
    ]
    return SuiteResult(
        suite="emergency",
        mode=ctx.mode,
        metrics=to_metrics(outcomes),
        cases=len(outcomes),
        failures=failures,
        detail_md=report(outcomes, ctx.mode),
        prompt_versions=[CLASSIFIER_PROMPT_ID, load_keyword_index().version],
        models={} if ctx.mode != "real" else {"classifier": str(make_settings("real").cheap_model)},
    )


SUITE = Suite(
    name="emergency",
    description="emergency keyword rules + classifier stage on text (recall must be 100%)",
    run=run,
    offline_modes=("rules", "fake"),
    real_mode=True,
    dataset=DATASET,
    est_real_cost_usd=0.10,
)
