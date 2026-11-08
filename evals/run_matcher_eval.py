"""Drug matching + generic finder evaluation (CLAUDE.md §11, M8 §8). The hard gates must be ZERO.

Runs the SAME matcher and finder the service uses on `evals/datasets/drug_matching/cases.jsonl`
(279 synthetic cases: messy spellings, Devanagari, generic names, combinations, SR vs plain, wrong
strengths, unknown brands, never-substitute drugs) against the real curated brand list plus the
fictional-price fixture, fully offline (in-memory catalog and vector store).

HARD GATES (exit code 1 when any is above zero; the report is written either way)
  wrong_strength        a suggested alternative has a different strength than the product meant
  wrong_form_release    ... a different form or release type (SR/ER/XR/CR/MR/DR vs plain)
  wrong_salt            ... a different salt
  forbidden_suggestion  any suggestion for an excluded drug (NTI, insulin, modified release, inhaler),
                        for an unknown medicine, or for an input that is unsafe to compare (written
                        strength or form contradicts the product, strength unverifiable, ambiguous)
Reported, not gated: match accuracy by method, wrong matches, `none` precision, suggestion coverage.

  uv run --project apps/ai-service python evals/run_matcher_eval.py
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
sys.path.insert(0, str(ROOT / "data" / "scripts"))

from catalog_sources import load_curated, load_fixture, to_drug_rows  # noqa: E402

from app.catalog.repository import DrugRow, InMemoryCatalogRepository  # noqa: E402
from app.catalog.vector import HashingEmbedder, InMemoryVectorStore  # noqa: E402
from app.safety.no_substitute import load_policy  # noqa: E402
from app.schemas.catalog import MatchMethod  # noqa: E402
from app.tools.drug_matcher import MatcherConfig, match_drug  # noqa: E402
from app.tools.generic_finder import FinderConfig, MedicineFacts, find_generic  # noqa: E402

DATASET = ROOT / "evals" / "datasets" / "drug_matching" / "cases.jsonl"
REPORTS = ROOT / "evals" / "reports"
GATES = ("wrong_strength", "wrong_form_release", "wrong_salt", "forbidden_suggestion")
FACTS = MedicineFacts(dose="1 tablet", frequency_per_day=2, duration_days=5)


@dataclass(slots=True)
class Result:
    case: dict[str, Any]
    method: str
    matched: dict[str, str | None]
    outcome: str  # correct | wrong | abstained (gold present), correct_none | false_match (gold none)
    alternatives: list[DrugRow] = field(default_factory=list)
    violations: list[str] = field(default_factory=list)


def load_cases(path: Path = DATASET) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def seed_rows() -> list[DrugRow]:
    records = load_curated(ROOT / "data" / "seed" / "brands_curated.csv").records
    records += load_fixture(ROOT / "data" / "seed" / "fixture_catalog.csv").records
    return to_drug_rows(records)


async def evaluate(
    cases: list[dict[str, Any]], rows: list[DrugRow] | None = None
) -> list[Result]:
    rows = rows if rows is not None else seed_rows()
    repo = InMemoryCatalogRepository(rows)
    vector = await InMemoryVectorStore.build(HashingEmbedder(), rows)
    policy, matcher, finder = load_policy(), MatcherConfig(), FinderConfig()
    results: list[Result] = []
    for case in cases:
        match = await match_drug(
            case["name"], case["strength"], case["form"], repo=repo, vector=vector, config=matcher
        )
        suggestion = await find_generic(match, FACTS, repo=repo, policy=policy, config=finder)
        alternatives = await repo.by_ids([a.drug_id for a in suggestion.alternatives])
        gold = case["gold"]
        matched = {
            "salt_key": match.salt_key,
            "strength_key": match.strength_key,
            "form_key": match.form_key,
            "release_type": match.release_type,
        }
        if gold is None and case["category"] != "unknown":
            outcome = "guarded"  # an input that is unsafe to compare: only "no suggestion" matters
        elif gold is None:
            outcome = "correct_none" if match.method is MatchMethod.none else "false_match"
        elif match.method is MatchMethod.none:
            outcome = "abstained"
        else:
            outcome = "correct" if matched == gold else "wrong"
        result = Result(case, match.method.value, matched, outcome, alternatives)
        result.violations = violations(case, alternatives)
        results.append(result)
    return results


def violations(case: dict[str, Any], alternatives: list[DrugRow]) -> list[str]:
    found: list[str] = []
    gold = case["gold"]
    for alt in alternatives:
        if case["forbid_suggestion"] or case["excluded"] or gold is None:
            found.append("forbidden_suggestion")
            continue
        if alt.salt_key != gold["salt_key"]:
            found.append("wrong_salt")
        if alt.strength_key != gold["strength_key"]:
            found.append("wrong_strength")
        if (alt.form_key, alt.release_type) != (gold["form_key"], gold["release_type"]):
            found.append("wrong_form_release")
    return found


def metrics(results: list[Result]) -> dict[str, Any]:
    gate_counts = Counter(v for r in results for v in r.violations)
    gold_cases = [r for r in results if r.case["gold"] is not None]
    none_cases = [r for r in results if r.case["category"] == "unknown"]
    guarded = [r for r in results if r.outcome == "guarded"]
    by_method: dict[str, Counter[str]] = defaultdict(Counter)
    for r in gold_cases:
        by_method[r.method][r.outcome] += 1
    expected = [r for r in results if r.case["expect_suggestion"]]
    return {
        "gates": {gate: gate_counts.get(gate, 0) for gate in GATES},
        "gold_total": len(gold_cases),
        "correct": sum(r.outcome == "correct" for r in gold_cases),
        "wrong": [r for r in gold_cases if r.outcome == "wrong"],
        "abstained": sum(r.outcome == "abstained" for r in gold_cases),
        "by_method": by_method,
        "guarded_total": len(guarded),
        "guarded_suggested": sum(bool(r.alternatives) for r in guarded),
        "none_total": len(none_cases),
        "none_correct": sum(r.outcome == "correct_none" for r in none_cases),
        "false_matches": [r for r in none_cases if r.outcome == "false_match"],
        "expected_total": len(expected),
        "expected_given": sum(bool(r.alternatives) for r in expected),
        "suggestions_total": sum(bool(r.alternatives) for r in results),
        "by_category": _by_category(results),
    }


def _by_category(results: list[Result]) -> dict[str, Counter[str]]:
    table: dict[str, Counter[str]] = defaultdict(Counter)
    for r in results:
        table[r.case["category"]][r.outcome] += 1
    return table


def gate_failures(m: dict[str, Any]) -> list[str]:
    return [f"{gate}: {count} violation(s), must be 0" for gate, count in m["gates"].items() if count]


def pct(a: int, b: int) -> str:
    return "n/a" if b == 0 else f"{a}/{b} ({100 * a / b:.1f}%)"


def report(results: list[Result], m: dict[str, Any], failures: list[str]) -> str:
    lines = [
        "# Drug matching and generic finder eval",
        "",
        "Offline run against the curated brand list + the FICTIONAL-price fixture. The cases are synthetic "
        "and written by us: they check the safety rules, not coverage of the real market.",
        "",
        f"- Date: {date.today().isoformat()}",
        f"- Cases: {len(results)} ({m['gold_total']} with a known product, {m['guarded_total']} unsafe-to-compare inputs, {m['none_total']} unknown names)",
        f"- Suggestions given: {m['suggestions_total']} cases",
        f"- **Hard gates: {'PASS' if not failures else 'FAIL'}**",
        *[f"  - FAILED: {failure}" for failure in failures],
        "",
        "## Hard gates (must be 0)",
        "",
        "| Gate | Violations |",
        "|---|---|",
        *[f"| {gate} | {count} |" for gate, count in m["gates"].items()],
        "",
        "## Matching (reported, not gated)",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Correct product (keys equal the gold) | {pct(m['correct'], m['gold_total'])} |",
        f"| Wrong product | {pct(len(m['wrong']), m['gold_total'])} |",
        f"| Abstained (no match) | {pct(m['abstained'], m['gold_total'])} |",
        f"| Unknown medicines correctly left unmatched (`none` precision) | {pct(m['none_correct'], m['none_total'])} |",
        f"| Unsafe-to-compare inputs (wrong strength/form, unverifiable, ambiguous) that got NO suggestion | {pct(m['guarded_total'] - m['guarded_suggested'], m['guarded_total'])} |",
        f"| Suggestion coverage on cases with a safe generic in the catalog | {pct(m['expected_given'], m['expected_total'])} |",
        "",
        "### By method (cases with a known product)",
        "",
        "| Method | Correct | Wrong |",
        "|---|---|---|",
        *[f"| {method} | {c['correct']} | {c['wrong']} |" for method, c in sorted(m["by_method"].items())],
        "",
        "### By category",
        "",
        "| Category | Outcomes |",
        "|---|---|",
        *[f"| {cat} | {dict(sorted(c.items()))} |" for cat, c in sorted(m["by_category"].items())],
        "",
        "## Wrong matches (no suggestion may have followed; see the gates)",
        "",
        *([f"- `{r.case['name']}` ({r.method}) matched {r.matched}, gold {r.case['gold']}" for r in m["wrong"]] or ["None."]),
        "",
        "## Unknown names that matched something (a real false match; none expected)",
        "",
        *([f"- `{r.case['name']}` ({r.method}) matched {r.matched}" for r in m["false_matches"]] or ["None."]),
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--no-report", action="store_true")
    args = parser.parse_args()
    results = asyncio.run(evaluate(load_cases()))
    m = metrics(results)
    failures = gate_failures(m)
    text = report(results, m, failures)
    print(text)
    if not args.no_report:
        REPORTS.mkdir(parents=True, exist_ok=True)
        target = REPORTS / f"{date.today().isoformat()}-drug-matcher-eval.md"
        target.write_text(text, encoding="utf-8")
        print(f"report written to {target.relative_to(ROOT)}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
