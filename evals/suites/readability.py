"""Readability suite: an LLM judge for the TONE and SIMPLICITY of replies (M14 §7). Soft metrics only.

It never decides safety or correctness (those are deterministic elsewhere). Two parts:
  1. VALIDATION: the judge scores 30 hand-labelled example replies; we report judge-human agreement.
     The labels were written by the developer / the assistant, not an independent panel: have a
     Hindi-speaking reader relabel `evals/datasets/judge/validation.jsonl` before trusting the number.
  2. SAMPLE: replies the pipeline really produces (prescriptions, lab reports, Hindi and English) are
     scored TWICE; the mean, the spread and the run-to-run agreement are reported (a judge that cannot
     repeat itself is not a measurement).
Modes: `fake` uses a deterministic stub judge (plumbing only); `real` uses `judge_readability_v1` on TEXT_MODEL.
"""

import json
import statistics
from dataclasses import dataclass

from app.labs.catalog import InMemoryLabRepository
from app.labs.service import LabService
from app.llm.factory import build_llm_router
from app.prompts.registry import PromptRegistry
from evals.harness import ROOT
from evals.harness.judge import Judge, ModelJudge, StubJudge, compare
from evals.harness.model import RunContext, Suite, SuiteResult
from evals.suites import lab as lab_suite
from evals.suites import rx as rx_suite

DATASET = ROOT / "evals" / "datasets" / "judge"
SAMPLE_RX = 6
SAMPLE_LAB = 4


@dataclass(slots=True)
class Example:
    id: str
    lang: str
    text: str
    human: int


def load_examples() -> list[Example]:
    rows = (
        json.loads(line)
        for line in (DATASET / "validation.jsonl").read_text(encoding="utf-8").splitlines()
        if line
    )
    return [Example(r["id"], r["lang"], r["text"], int(r["human_score"])) for r in rows]


async def collect_replies(mode: str) -> list[str]:
    settings = rx_suite.make_settings(mode)
    catalog = rx_suite.make_catalog()
    replies: list[str] = []
    for index, case in enumerate(rx_suite.load_cases(rx_suite.DATASET, SAMPLE_RX)):
        result = await rx_suite.run_case(case, index, mode, settings, catalog)
        replies.append(result.output.reply.text)
    labs = LabService(InMemoryLabRepository())
    for index, case in enumerate(lab_suite.load_cases(lab_suite.DATASET, SAMPLE_LAB)):
        language = "hi" if index % 2 else "en"
        result = await lab_suite.run_case(case, index, mode, settings, labs, language)
        replies.append(result.output.reply.text)
    return replies


def make_judge(mode: str) -> Judge:
    if mode != "real":
        return StubJudge()
    settings = rx_suite.make_settings("real")
    return ModelJudge(build_llm_router(settings, fake_provider=None), PromptRegistry())


async def run(ctx: RunContext) -> SuiteResult:
    judge = make_judge(ctx.mode)
    examples = load_examples()
    if ctx.limit:
        examples = examples[: ctx.limit]
    human = [e.human for e in examples]
    judged = [await judge.score(e.text) for e in examples]
    validation = compare(judged, human)

    replies = await collect_replies("fake" if ctx.mode != "real" else "real")
    first = [await judge.score(r) for r in replies]
    second = [await judge.score(r) for r in replies]
    repeat = compare(first, second)
    valid = [s for s in first + second if s > 0]
    errors = sum(1 for s in judged + first + second if s == 0)
    cost = judge.cost_usd if isinstance(judge, ModelJudge) else 0.0
    if isinstance(judge, ModelJudge):
        ctx.budget.add(cost)

    metrics: dict[str, float] = {
        "validation_examples": float(len(examples)),
        "judge_errors": float(errors),
        "judge_human_exact": validation.exact,
        "judge_human_within_one": validation.within_one,
        "judge_human_mae": validation.mean_abs_error,
        "judge_repeat_exact": repeat.exact,
        "judge_repeat_within_one": repeat.within_one,
        "readability_mean": statistics.fmean(valid) if valid else 0.0,
        "readability_std": statistics.pstdev(valid) if len(valid) > 1 else 0.0,
        "sample_size": float(len(replies)),
    }
    lines = [
        "# Readability judge",
        "",
        f"Judge: `{judge.name}` ({'deterministic stub: plumbing only' if ctx.mode != 'real' else 'TEXT_MODEL, judge_readability_v1'}).",
        "",
        "| Part | Value |",
        "|---|---|",
        f"| Validation examples | {len(examples)} (labels by the developer, not an independent panel) |",
        f"| Judge vs human: exact / within 1 point / mean abs error | {validation.exact:.0%} / {validation.within_one:.0%} / {validation.mean_abs_error:.2f} |",
        f"| Pipeline replies scored twice | {len(replies)} |",
        f"| Run 1 vs run 2: identical / within 1 point | {repeat.exact:.0%} / {repeat.within_one:.0%} |",
        f"| Mean score / spread (std) | {metrics['readability_mean']:.2f} / {metrics['readability_std']:.2f} |",
        "",
        "The judge grades writing only. It never gates safety or correctness.",
        "",
    ]
    return SuiteResult(
        suite="readability",
        mode=ctx.mode,
        metrics=metrics,
        cases=len(examples) + len(replies),
        detail_md="\n".join(lines),
        cost_usd=cost,
        prompt_versions=["judge_readability_v1"],
        models={"text": str(rx_suite.make_settings("real").text_model)} if ctx.is_real else {},
        notes=[
            "Soft metrics only: a low readability score warns, it never blocks a merge on its own."
        ],
    )


SUITE = Suite(
    name="readability",
    description="LLM judge for reply readability and tone (soft only; never safety)",
    run=run,
    offline_modes=("fake",),
    real_mode=True,
    dataset=DATASET,
    est_real_cost_usd=0.40,
)
