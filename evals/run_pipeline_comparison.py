"""Regression check for the LangGraph migration (M9): the same evals through BOTH pipelines.

  minimal   `RxPipeline(MinimalPipeline())`, the pre-graph code (still there as `PIPELINE=minimal`)
  graph     `GraphPipeline()`, the LangGraph state machine (the default since M9)

Three eval sets run end to end through each pipeline (fake models: offline, deterministic):
  emergency   the 152 emergency messages (M6): recall on positives, false positives on clear negatives
  rx          the synthetic prescriptions (M7 + M8 suggestions): safety gates and per-field accuracy
  generics    the 279 drug-matching cases (M8) asked as typed "<name> ka generic batao" questions: the
              four hard gates (wrong strength / form-release / salt, forbidden suggestion)

The graph must be EQUAL to or BETTER than the minimal pipeline on every metric, and every hard gate
must be 0. The report has a before/after table. Exit code 1 otherwise.

  uv run --project apps/ai-service python evals/run_pipeline_comparison.py
"""

import argparse
import asyncio
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "evals"))

import run_emergency_eval as emergency_eval  # noqa: E402
import run_matcher_eval as matcher_eval  # noqa: E402
import run_rx_eval as rx_eval  # noqa: E402

from app.llm.factory import build_llm_router  # noqa: E402
from app.llm.fake import FakeProvider  # noqa: E402
from app.llm.router import Deadline  # noqa: E402
from app.catalog.repository import InMemoryCatalogRepository  # noqa: E402
from app.catalog.service import CatalogService  # noqa: E402
from app.observability.logging import configure_logging  # noqa: E402
from app.pipeline.base import PipelineContext, RequestUsage  # noqa: E402
from app.prompts.registry import PromptRegistry, TemplateStore  # noqa: E402
from app.safety.emergency_guard import EmergencyGuard  # noqa: E402
from app.safety.redaction import Redactor  # noqa: E402
from app.schemas.process import ProcessRequest  # noqa: E402

REPORTS = ROOT / "evals" / "reports"
PIPELINES = ("minimal", "graph")


@dataclass(frozen=True, slots=True)
class Metric:
    name: str
    values: dict[str, float]
    higher_is_better: bool
    gate: bool = False  # a hard gate: must be 0 in the graph

    def verdict(self) -> str:
        minimal, graph = self.values["minimal"], self.values["graph"]
        if graph == minimal:
            return "equal"
        better = graph > minimal if self.higher_is_better else graph < minimal
        return "better" if better else "WORSE"


def text_context(catalog: CatalogService | None) -> PipelineContext:
    settings = rx_eval.make_settings("fake")
    return PipelineContext(
        settings=settings,
        router=build_llm_router(settings, fake_provider=FakeProvider()),
        prompts=PromptRegistry(),
        templates=TemplateStore(),
        deadline=Deadline(settings.process_timeout_s),
        usage=RequestUsage(),
        guard=EmergencyGuard(),
        redactor=Redactor(enabled=True),
        catalog=catalog,
    )


def text_request(index: int, text: str) -> ProcessRequest:
    return ProcessRequest.model_validate(
        {
            "request_id": f"cmp-{index}",
            "user": {"language": "en", "age": None, "sex": None},
            "input": {"type": "text", "text": text},
        }
    )


# ---------------------------------------------------------------- emergency


async def run_emergency(name: str) -> dict[str, float]:
    pipeline = rx_eval.build_pipeline(name)
    rows = emergency_eval.load_rows()
    flagged: list[tuple[Any, bool]] = []
    for index, row in enumerate(rows):
        output = await pipeline.run(text_request(index, row.text), text_context(None))
        flagged.append((row, output.emergency))
    positives = [hit for row, hit in flagged if row.expected_emergency]
    clear = [hit for row, hit in flagged if not row.expected_emergency and row.kind == "clear"]
    return {
        "missed_emergencies": float(sum(not hit for hit in positives)),
        "recall_pct": 100 * sum(positives) / len(positives),
        "clear_negatives_flagged": float(sum(clear)),
    }


# ---------------------------------------------------------------- prescriptions


async def run_rx(name: str) -> dict[str, float]:
    cases = rx_eval.load_cases()
    results = await rx_eval.evaluate(cases, "fake", name)
    scores = rx_eval.score(results)
    precision = scores.tp / (scores.tp + scores.fp) if scores.tp + scores.fp else 0.0
    recall = scores.tp / (scores.tp + scores.fn) if scores.tp + scores.fn else 0.0
    metrics: dict[str, float] = {
        "flag_misses": float(scores.flag.total - scores.flag.ok),
        "phi_leaks": float(len(scores.leaks)),
        "hallucinated_medicines": float(len(scores.hallucinated)),
        "ungrounded_names": float(scores.grounded.total - scores.grounded.ok),
        "unsafe_generic_suggestions": float(len(scores.generic_issues)),
        "errors": float(scores.errors),
        "medicine_precision": precision,
        "medicine_recall": recall,
    }
    for field, tally in scores.fields.items():
        metrics[f"accuracy: {field}"] = tally.ok / tally.total if tally.total else 1.0
    metrics["documents_done"] = float(scores.status_counts.get("done", 0))
    metrics["documents_needs_review"] = float(scores.status_counts.get("needs_review", 0))
    metrics["documents_failed"] = float(scores.status_counts.get("failed", 0))
    return metrics


# ---------------------------------------------------------------- generic questions


def listed_brands(text: str) -> list[str]:
    """The alternatives a reply lists: lines that start with a bullet, up to the tag or the price."""
    names = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("•"):
            name = stripped[1:].strip().split(" 🏷️")[0].split(" — ")[0].strip()
            names.append(name)
    return names


async def run_generics(name: str) -> dict[str, float]:
    pipeline = rx_eval.build_pipeline(name)
    rows = matcher_eval.seed_rows()
    catalog = CatalogService(InMemoryCatalogRepository(rows))
    by_name = {row.brand_name: row for row in rows}
    gates = dict.fromkeys(matcher_eval.GATES, 0)
    suggested = 0
    for index, case in enumerate(matcher_eval.load_cases()):
        question = " ".join(part for part in (case["name"], case["form"], case["strength"], "ka generic batao") if part)
        output = await pipeline.run(text_request(index, question), text_context(catalog))
        alternatives = [by_name[b] for b in listed_brands(output.reply.text) if b in by_name]
        suggested += bool(alternatives)
        for violation in matcher_eval.violations(case, alternatives):
            gates[violation] += 1
    return {**{f"gate: {gate}": float(count) for gate, count in gates.items()}, "cases_with_a_suggestion": float(suggested)}


# ---------------------------------------------------------------- report


def collect(per_pipeline: dict[str, dict[str, float]], section: str) -> list[tuple[str, Metric]]:
    metrics: list[tuple[str, Metric]] = []
    for key in per_pipeline["minimal"]:
        lower_is_better = key in _LOWER_BETTER or key.startswith("gate:")
        metrics.append(
            (
                section,
                Metric(
                    key,
                    {p: per_pipeline[p][key] for p in PIPELINES},
                    higher_is_better=not lower_is_better,
                    gate=key.startswith("gate:") or key in _GATES,
                ),
            )
        )
    return metrics


_LOWER_BETTER = {
    "missed_emergencies", "clear_negatives_flagged", "flag_misses", "phi_leaks", "hallucinated_medicines",
    "ungrounded_names", "unsafe_generic_suggestions", "errors", "documents_failed",
}  # fmt: skip
_GATES = {"missed_emergencies", "flag_misses", "phi_leaks", "hallucinated_medicines", "ungrounded_names", "unsafe_generic_suggestions", "errors"}


def fmt(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:.3f}"


def report(rows: list[tuple[str, Metric]], failures: list[str]) -> str:
    lines = [
        "# LangGraph migration: regression comparison",
        "",
        "The same evals through the pre-graph pipeline (`minimal`) and the LangGraph pipeline (`graph`), "
        "with fake models (offline). **This checks that the migration changed no behaviour; it does not "
        "measure model quality.**",
        "",
        f"- Date: {date.today().isoformat()}",
        f"- **Result: {'PASS' if not failures else 'FAIL'}**",
        *[f"  - FAILED: {failure}" for failure in failures],
        "",
    ]
    current = ""
    for section, metric in rows:
        if section != current:
            current = section
            lines += [f"## {section}", "", "| Metric | minimal | graph | verdict |", "|---|---|---|---|"]
        gate = " (hard gate)" if metric.gate else ""
        lines.append(
            f"| {metric.name}{gate} | {fmt(metric.values['minimal'])} | {fmt(metric.values['graph'])} | {metric.verdict()} |"
        )
        nxt = rows[rows.index((section, metric)) + 1][0] if (section, metric) != rows[-1] else None
        if nxt != section:
            lines.append("")
    return "\n".join(lines)


def failures_of(rows: list[tuple[str, Metric]]) -> list[str]:
    failures = []
    for _, metric in rows:
        if metric.verdict() == "WORSE":
            failures.append(f"{metric.name}: graph {fmt(metric.values['graph'])} is worse than minimal {fmt(metric.values['minimal'])}")
        if metric.gate and metric.values["graph"] != 0:
            failures.append(f"hard gate {metric.name} is {fmt(metric.values['graph'])}, must be 0")
    return failures


async def compare() -> list[tuple[str, Metric]]:
    rows: list[tuple[str, Metric]] = []
    for section, runner in (("Emergency messages (M6)", run_emergency), ("Prescriptions (M7, M8)", run_rx), ("Typed generic questions (M8)", run_generics)):
        per_pipeline = {name: await runner(name) for name in PIPELINES}
        rows += collect(per_pipeline, section)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--no-report", action="store_true")
    args = parser.parse_args()
    configure_logging("silent")
    rows = asyncio.run(compare())
    failures = failures_of(rows)
    text = report(rows, failures)
    sys.stdout.buffer.write((text + "\n").encode("utf-8"))
    if not args.no_report:
        REPORTS.mkdir(parents=True, exist_ok=True)
        target = REPORTS / f"{date.today().isoformat()}-graph-vs-minimal.md"
        target.write_text(text + "\n", encoding="utf-8")
        sys.stderr.write(f"report written to {target.relative_to(ROOT)}\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
