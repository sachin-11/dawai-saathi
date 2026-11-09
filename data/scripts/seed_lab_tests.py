"""Load the lab reference data (data/seed/lab_tests.yaml) into `lab_tests` (M12).

  make seed                                  runs this after the catalog and the interactions
  python data/scripts/seed_lab_tests.py --check   validate and write the review file only, no database

The YAML is the source of truth; the table is rewritten in ONE transaction (delete all, insert all), so
a removed test disappears and a second run changes nothing. Critical limits come from
apps/ai-service/app/safety/critical_values.yaml (also the runtime source of truth).

!! The numbers are NOT clinically reviewed (see the header of the YAML). The Hindi text is a generic safe
!! line until a human fills data/review/lab_tests_hi_reviewed.csv (columns: code, explanation_hi): rows found
!! there are loaded with hi_reviewed = true. data/review/lab_tests_hi_review.csv is what the reviewer gets.
"""

import argparse
import asyncio
import csv
import json
import os
import sys
from collections import Counter
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))

from app.labs.catalog import LabTest, build_lab_tests, load_seed  # noqa: E402
from app.safety.critical_values import load_critical_values  # noqa: E402

REVIEW = ROOT / "data" / "review"
REPORTS = ROOT / "data" / "reports"

INSERT = """
INSERT INTO lab_tests (
  code, name, aliases, unit, ref_low, ref_high, sex, age_min, age_max, explanation_en, explanation_hi,
  source, section, unit_conversions, critical_low, critical_high, doctor_questions_en,
  doctor_questions_hi, qualitative_normal, hi_reviewed
) VALUES ($1,$2,$3,$4,$5,$6,$7::lab_sex,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20)
"""


def problems(tests: list[LabTest]) -> list[str]:
    found: list[str] = []
    codes = Counter(t.code for t in tests)
    found += [f"duplicate code {c}" for c, n in codes.items() if n > 1]
    seen: dict[str, str] = {}
    for test in tests:
        for alias in {test.name.lower(), *(a.lower() for a in test.aliases)}:
            owner = seen.setdefault(alias, test.code)
            if owner != test.code:
                found.append(f"alias {alias!r} is used by {owner} and {test.code}")
        if not test.source:
            found.append(f"{test.code}: no source")
        if not test.ranges and not test.is_qualitative:
            found.append(f"{test.code}: neither a range nor a qualitative rule")
        for variant in test.ranges:
            if variant.low is not None and variant.high is not None and variant.low >= variant.high:
                found.append(f"{test.code}: empty range {variant}")
    codes_known = set(codes)
    found += [
        f"critical value for unknown test {code}"
        for code in load_critical_values()
        if code not in codes_known
    ]
    return found


def apply_reviewed(tests: list[LabTest], path: Path) -> list[LabTest]:
    if not path.exists():
        return tests
    from dataclasses import replace

    with path.open(encoding="utf-8", newline="") as handle:
        reviewed = {
            row["code"]: row["explanation_hi"].strip()
            for row in csv.DictReader(handle)
            if row.get("explanation_hi", "").strip()
        }
    return [
        replace(t, explanation_hi=reviewed[t.code], hi_reviewed=True) if t.code in reviewed else t
        for t in tests
    ]


def rows_for(test: LabTest) -> list[tuple[object, ...]]:
    conversions = {
        unit: (c.factor if c.offset == 0 else {"f": c.factor, "o": c.offset})
        for unit, c in test.conversions.items()
    }
    variants = list(test.ranges) or [None]
    rows: list[tuple[object, ...]] = []
    for variant in variants:
        rows.append(
            (
                test.code, test.name, list(test.aliases), test.unit,
                None if variant is None else variant.low,
                None if variant is None else variant.high,
                "any" if variant is None else variant.sex,
                None if variant is None else variant.age_min,
                None if variant is None else variant.age_max,
                test.explanation_en, test.explanation_hi, test.source, test.section,
                json.dumps(conversions), test.critical_low, test.critical_high,
                list(test.questions_en), list(test.questions_hi), list(test.qualitative_normal),
                test.hi_reviewed,
            )
        )  # fmt: skip
    return rows


def write_review_file(tests: list[LabTest]) -> Path:
    REVIEW.mkdir(parents=True, exist_ok=True)
    target = REVIEW / "lab_tests_hi_review.csv"
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "code",
                "name",
                "english_explanation",
                "hindi_current",
                "explanation_hi (fill in)",
                "source",
            ]
        )
        for t in tests:
            writer.writerow([t.code, t.name, t.explanation_en, t.explanation_hi, "", t.source])
    return target


def write_report(tests: list[LabTest]) -> Path:
    REPORTS.mkdir(parents=True, exist_ok=True)
    sections = Counter(t.section for t in tests)
    lines = [
        f"# Lab reference data report ({date.today().isoformat()})",
        "",
        f"- tests: {len(tests)} ({sum(len(t.ranges) for t in tests)} range rows)",
        f"- with critical limits: {sum(1 for t in tests if t.critical_low or t.critical_high)}",
        f"- Hindi text reviewed by a human: {sum(t.hi_reviewed for t in tests)} of {len(tests)}",
        f"- sections: {dict(sections)}",
        "",
        "NOT CLINICALLY REVIEWED: ranges, explanations and critical limits need a doctor / pathologist.",
        "",
    ]
    target = REPORTS / f"{date.today().isoformat()}-lab-tests.md"
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


async def load_into_db(tests: list[LabTest]) -> None:
    import asyncpg

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set (the gateway's read-write URL is needed to seed)")
    conn = await asyncpg.connect(url)
    try:
        async with conn.transaction():
            await conn.execute("DELETE FROM lab_tests")
            await conn.executemany(INSERT, [row for t in tests for row in rows_for(t)])
    finally:
        await conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--reviewed-hi", default=str(REVIEW / "lab_tests_hi_reviewed.csv"))
    parser.add_argument("--check", action="store_true", help="validate and write files only")
    args = parser.parse_args()

    tests = apply_reviewed(build_lab_tests(load_seed()), Path(args.reviewed_hi))
    found = problems(tests)
    review = write_review_file(tests)
    report = write_report(tests)
    print(
        f"{len(tests)} lab tests; report: {report.relative_to(ROOT)}; Hindi review: {review.relative_to(ROOT)}"
    )
    if found:
        print("PROBLEMS:\n  " + "\n  ".join(found), file=sys.stderr)
        return 1
    if not args.check:
        asyncio.run(load_into_db(tests))
        print(f"loaded {sum(len(t.ranges) or 1 for t in tests)} lab_tests rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
