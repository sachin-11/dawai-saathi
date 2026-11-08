"""Interaction checker evaluation (CLAUDE.md §11, M11 §7). The hard gates are checked on every run.

Runs the SAME checker, wording, verifier and graph the service uses on
`evals/datasets/interactions/cases.jsonl` (hand-written gold, see `build_cases.py`), offline: the
committed core list as in-memory rows, the curated brand catalog, a fake LLM that only copies names.

HARD GATES (exit code 1 when violated; the report is written either way)
  pair_recall            100%   every expected interaction is found (a deterministic lookup)
  duplicate_recall       100%   every expected duplicate ingredient is found
  hallucinated           0      a finding or a sentence in a reply for a pair that is not expected
  stop_advice            0      any reply (en + hi, main and details) that tells the user to stop/skip
  unchecked_called_safe  0      a medicine that could not be checked is never reported as fine
  severity_wording       100%   the "Important" marker appears exactly when a major finding is shown
  wrong_severity         0      a found pair with a different severity than expected
Reported, not gated: coverage by category, how many expected pairs the questions resolved.

  uv run --project apps/ai-service python evals/run_interaction_eval.py
"""

import argparse
import asyncio
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))
sys.path.insert(0, str(ROOT / "apps" / "ai-service" / "tests"))
sys.path.insert(0, str(ROOT / "data" / "scripts"))
sys.path.insert(0, str(ROOT))

from app.interactions.effects import EFFECTS  # noqa: E402
from app.interactions.render import (  # noqa: E402
    MAJOR_MARKER,
    TEXT,
    render_block,
    render_details,
    shown_findings,
)
from app.interactions.repository import InMemoryInteractionRepository  # noqa: E402
from app.interactions.verify import advice_to_stop, interaction_failures  # noqa: E402
from app.llm.fake import FakeProvider  # noqa: E402
from app.schemas.interactions import InteractionReport  # noqa: E402
from app.schemas.process import Language  # noqa: E402
from app.tools.interaction_check import CheckedMedication, check_interactions  # noqa: E402

DATASET = ROOT / "evals" / "datasets" / "interactions" / "cases.jsonl"
REPORTS = ROOT / "evals" / "reports"
GATES = (
    "pair_recall",
    "duplicate_recall",
    "hallucinated",
    "stop_advice",
    "unchecked_called_safe",
    "severity_wording",
    "wrong_severity",
)


@dataclass(slots=True)
class CaseResult:
    case: dict[str, Any]
    report: InteractionReport
    replies: dict[str, str] = field(default_factory=dict)
    violations: list[str] = field(default_factory=list)
    pairs_expected: int = 0
    pairs_found: int = 0
    dups_expected: int = 0
    dups_found: int = 0


def load_cases(path: Path = DATASET) -> list[dict[str, Any]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def key_of(f: dict[str, Any]) -> tuple[str, str, str]:
    return (f["type"], f["salts"][0], f["salts"][1])


def compare(case: dict[str, Any], report: InteractionReport) -> CaseResult:
    """Findings against the gold, plus every wording check for both languages."""
    result = CaseResult(case=case, report=report)
    expected = {key_of(f): f for f in case["expect"]["findings"]}
    got = {(f.type, f.salt_a, f.salt_b): f for f in report.findings}
    for key, gold in expected.items():
        kind = "pairs" if key[0] == "interaction" else "dups"
        setattr(result, f"{kind}_expected", getattr(result, f"{kind}_expected") + 1)
        if key in got:
            setattr(result, f"{kind}_found", getattr(result, f"{kind}_found") + 1)
            if gold["severity"] and got[key].severity != gold["severity"]:
                result.violations.append(f"wrong_severity:{key[1]}+{key[2]}")
        else:
            result.violations.append(
                f"{'pair' if kind == 'pairs' else 'duplicate'}_missed:{key[1]}+{key[2]}"
            )
    for key in got.keys() - expected.keys():
        result.violations.append(f"hallucinated:{key[1]}+{key[2]}")

    # Wording, both languages, main block and details view
    gold_effects = {f["effect"] for f in case["expect"]["findings"] if f.get("effect")}
    unchecked = case["expect"]["unchecked"]
    query = case["category"] == "question"
    for language in (Language.en, Language.hi):
        block = render_block(report, language, query=query)
        details = render_details(report.findings, {}, report, language)
        result.replies[f"main-{language.value}"] = block
        result.replies[f"details-{language.value}"] = details
        for name, text in ((f"main-{language.value}", block), (f"details-{language.value}", details)):
            if advice_to_stop(text):
                result.violations.append(f"stop_advice:{name}")
        # no effect sentence that the gold does not justify
        for code, (en, hi) in EFFECTS.items():
            phrase = en if language is Language.en else hi
            if phrase in block and code not in gold_effects:
                result.violations.append(f"hallucinated_sentence:{code}")
        # the severity marker appears exactly when a major finding is shown
        expect_major = any(
            f["severity"] == "major" for f in case["expect"]["findings"]
        ) and any(f.management_key == "major" for f in shown_findings(report, query=query))
        has_marker = MAJOR_MARKER[language] in block
        if has_marker != expect_major:
            result.violations.append(f"severity_wording:{language.value}")
        # an unchecked medicine is named and never called fine
        if unchecked:
            for label in unchecked:
                if label not in block:
                    result.violations.append(f"unchecked_missing:{label}")
            unsafe = TEXT[language]["unchecked"].split("{")[0][:24]
            if unsafe not in block:
                result.violations.append(f"unchecked_called_safe:{language.value}")
        if report.checked_count < 2 and not report.findings and TEXT[language]["none"][:24] in block:
            result.violations.append(f"unchecked_called_safe:nothing_checked:{language.value}")
        # the independent verifier agrees with the wording
        problems = interaction_failures(
            report, block, language, required=False, whole_reply_blocklist=True, query=query
        )
        result.violations += [f"verifier:{p}" for p in problems]
    return result


def medications_of(case: dict[str, Any]) -> list[CheckedMedication]:
    return [
        CheckedMedication(
            ref=f"{'rx' if m['new'] else 's'}:{index}",
            label=m["label"],
            salt_key=m["salt_key"],
            is_new=m["new"],
        )
        for index, m in enumerate(case["medicines"])
    ]


async def run_checker_case(case: dict[str, Any], repo: InMemoryInteractionRepository) -> CaseResult:
    report = await check_interactions(
        medications_of(case), repo, only_new=case.get("only_new", True)
    )
    return compare(case, report)


async def run_question_case(case: dict[str, Any], service: Any, catalog: Any) -> CaseResult:
    from tests.graph_support import run_graph, text_request
    from tests.interaction_support import with_context

    request = text_request(case["text"], case["language"])
    stored = [
        {
            "salt": s["salt_key"],
            "strength": None,
            "medication_id": f"00000000-0000-0000-0000-{index:012d}",
            "name": s["name"],
            "salt_key": s["salt_key"],
        }
        for index, s in enumerate(case["stored"], 1)
    ]
    if stored:
        request = with_context(request, stored)
    output, _ = await run_graph(FakeProvider([]), request, catalog, service)
    report = output.interactions or InteractionReport()
    result = compare(case, report)
    reply = output.reply.text
    result.replies["reply"] = reply
    if advice_to_stop(reply):
        result.violations.append("stop_advice:reply")
    if case.get("asks_names"):
        if "Which medicines do you want to check" not in reply and "किन दवाइयों" not in reply:
            result.violations.append("asks_names_missing")
        return result
    language = Language(case["language"])
    if output.interactions is None:
        result.violations.append("no_report")
    elif render_block(report, language, query=True) not in reply:
        result.violations.append("reply_missing_block")
    if case.get("says_none"):
        if TEXT[language]["none"][:24] not in reply:
            result.violations.append("none_line_missing")
        if "safe" in reply.lower().replace("not safe", ""):
            result.violations.append("unchecked_called_safe:reply")
    return result


async def evaluate(cases: list[dict[str, Any]]) -> list[CaseResult]:
    from tests.graph_support import seeded_catalog
    from tests.interaction_support import core_repo, core_service

    repo = core_repo()
    service = core_service()
    catalog = seeded_catalog()
    results: list[CaseResult] = []
    for case in cases:
        if case["category"] == "question":
            results.append(await run_question_case(case, service, catalog))
        else:
            results.append(await run_checker_case(case, repo))
    return results


def metrics(results: list[CaseResult]) -> dict[str, Any]:
    count: Counter[str] = Counter()
    for r in results:
        for v in r.violations:
            count[v.split(":")[0]] += 1
    pairs_expected = sum(r.pairs_expected for r in results)
    pairs_found = sum(r.pairs_found for r in results)
    dups_expected = sum(r.dups_expected for r in results)
    dups_found = sum(r.dups_found for r in results)
    hallucinated = count["hallucinated"] + count["hallucinated_sentence"]
    return {
        "cases": len(results),
        "pairs_expected": pairs_expected,
        "pairs_found": pairs_found,
        "dups_expected": dups_expected,
        "dups_found": dups_found,
        "gates": {
            "pair_recall": 0 if pairs_found == pairs_expected else pairs_expected - pairs_found,
            "duplicate_recall": 0 if dups_found == dups_expected else dups_expected - dups_found,
            "hallucinated": hallucinated,
            "stop_advice": count["stop_advice"],
            "unchecked_called_safe": count["unchecked_called_safe"] + count["unchecked_missing"],
            "severity_wording": count["severity_wording"],
            "wrong_severity": count["wrong_severity"],
        },
        "other_violations": {
            k: v
            for k, v in count.items()
            if k
            not in {
                "hallucinated", "hallucinated_sentence", "stop_advice", "unchecked_called_safe",
                "unchecked_missing", "severity_wording", "wrong_severity", "pair_missed",
                "duplicate_missed",
            }
        },
    }  # fmt: skip


def write_report(results: list[CaseResult], summary: dict[str, Any]) -> Path:
    REPORTS.mkdir(parents=True, exist_ok=True)
    by_category: dict[str, list[CaseResult]] = defaultdict(list)
    for r in results:
        by_category[r.case["category"]].append(r)
    lines = [
        f"# Interaction eval ({date.today().isoformat()}, fake LLM, core list v1)",
        "",
        f"- cases: {summary['cases']}",
        f"- expected interactions found: {summary['pairs_found']} / {summary['pairs_expected']}",
        f"- expected duplicate ingredients found: {summary['dups_found']} / {summary['dups_expected']}",
        "",
        "## Hard gates (all must be 0)",
        "",
    ]
    lines += [f"- {name}: {value}" for name, value in summary["gates"].items()]
    lines += ["", "## By category", ""]
    for name, items in sorted(by_category.items()):
        clean = sum(1 for r in items if not r.violations)
        lines.append(f"- {name}: {clean} / {len(items)} cases with no violation")
    failing = [r for r in results if r.violations]
    if failing:
        lines += ["", "## Violations", ""]
        for r in failing:
            lines.append(f"- {r.case['id']}: {', '.join(r.violations)}")
    lines += [
        "",
        "Coverage is PARTIAL: the core list is a small curated set. A case with no expected finding",
        "means 'no row in our list', never 'safe'.",
        "",
    ]
    target = REPORTS / f"{date.today().isoformat()}-interactions.md"
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-report", action="store_true")
    args = parser.parse_args()
    results = asyncio.run(evaluate(load_cases()))
    summary = metrics(results)
    if not args.no_report:
        print(f"report: {write_report(results, summary).relative_to(ROOT)}")
    print(
        f"{summary['cases']} cases: interactions {summary['pairs_found']}/{summary['pairs_expected']}, "
        f"duplicates {summary['dups_found']}/{summary['dups_expected']}"
    )
    bad = False
    for name, value in summary["gates"].items():
        print(f"  {name}: {value}")
        bad = bad or value != 0
    if summary["other_violations"]:
        print(f"  other violations: {summary['other_violations']}")
        bad = True
    for r in results:
        if r.violations:
            print(f"  FAIL {r.case['id']}: {', '.join(r.violations)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
