"""Load the curated interaction list into `interactions`, write a report and the Hindi review files.

  make seed                    runs this after the catalog (see the Makefile)
  python data/scripts/seed_interactions.py --check     parse and report only, no database

Idempotent: rows are upserted on (salt_a, salt_b); rows of this source that are no longer in the CSV
are removed (warnings that pointed at them keep their record, the link becomes null). Source, licence
reasoning and the partial-coverage warning are in data/SOURCES.md.
"""

import argparse
import asyncio
import csv
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from catalog_sources import load_curated, load_fixture  # noqa: E402
from interaction_sources import (  # noqa: E402
    SOURCE_NAME,
    LoadResult,
    catalog_salts_from,
    load_interactions,
    load_reviewed_hi,
)

from app.interactions.effects import EFFECTS  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "data" / "seed"
REPORTS = Path(os.environ.get("SEED_REPORT_DIR", ROOT / "data" / "reports"))
REVIEW = Path(os.environ.get("SEED_REVIEW_DIR", ROOT / "data" / "review"))

UPSERT = """
INSERT INTO interactions (
  salt_a, salt_b, severity, summary, source, mechanism, effect_code, management_en, management_hi,
  hi_reviewed, evidence_level, source_ref, source_version
) VALUES ($1,$2,$3::interaction_severity,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT (salt_a, salt_b) DO UPDATE SET
  severity=EXCLUDED.severity, summary=EXCLUDED.summary, source=EXCLUDED.source,
  mechanism=EXCLUDED.mechanism, effect_code=EXCLUDED.effect_code,
  management_en=EXCLUDED.management_en, management_hi=EXCLUDED.management_hi,
  hi_reviewed=EXCLUDED.hi_reviewed, evidence_level=EXCLUDED.evidence_level,
  source_ref=EXCLUDED.source_ref, source_version=EXCLUDED.source_version
"""


def _shown(path: Path) -> Path:
    """A path relative to the repo when it is inside it (reports can be redirected with SEED_REPORT_DIR)."""
    return path.relative_to(ROOT) if path.is_relative_to(ROOT) else path


def collect(reviewed_path: Path) -> LoadResult:
    catalog = [load_curated(SEED / "brands_curated.csv"), load_fixture(SEED / "fixture_catalog.csv")]
    salts = catalog_salts_from([r for result in catalog for r in result.records])
    return load_interactions(
        SEED / "interactions_core.csv",
        SEED / "interaction_classes.csv",
        catalog_salts=salts,
        reviewed_hi=load_reviewed_hi(reviewed_path),
    )


def write_report(result: LoadResult) -> Path:
    REPORTS.mkdir(parents=True, exist_ok=True)
    by_severity: dict[str, int] = {}
    for record in result.records:
        by_severity[record.severity] = by_severity.get(record.severity, 0) + 1
    lines = [
        f"# Interaction ingestion report ({date.today().isoformat()})",
        "",
        f"- source: {SOURCE_NAME}",
        f"- core rows read: {result.rows_read}",
        f"- pairs after class expansion: {result.pairs_expanded}",
        f"- stored (de-duplicated): {len(result.records)}  {by_severity}",
        f"- Hindi text reviewed by a human: {sum(r.hi_reviewed for r in result.records)} of "
        f"{len(result.records)}",
        f"- rejected: {sum(result.rejected.values())}",
    ]
    for reason, count in result.rejected.most_common():
        lines.append(f"  - {reason}: {count} (e.g. {'; '.join(result.examples.get(reason, []))})")
    if result.conflicts:
        lines += ["", "## Severity disagreements (the higher severity was kept)", ""]
        lines += [f"- {c}" for c in result.conflicts]
    if result.unknown_to_catalog:
        lines += [
            "",
            "## Salts with no product in the loaded catalog (their pairs cannot fire yet)",
            "",
            ", ".join(sorted(result.unknown_to_catalog)),
        ]
    lines += [
        "",
        "COVERAGE IS PARTIAL: absence of a pair here does not mean the pair is safe.",
        "",
    ]
    target = REPORTS / f"{date.today().isoformat()}-interactions.md"
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def write_review_files(result: LoadResult) -> tuple[Path, Path]:
    """What a pharmacist or doctor must check before the Hindi text counts as reviewed."""
    REVIEW.mkdir(parents=True, exist_ok=True)
    pairs = REVIEW / "interactions_hi_review.csv"
    with pairs.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["salt_a", "salt_b", "severity", "effect_code", "management_hi_current", "management_hi"]
        )
        for r in result.records:
            writer.writerow([r.salt_a, r.salt_b, r.severity, r.effect_code, r.management_hi, ""])
    effects = REVIEW / "interaction_effects_hi_review.csv"
    with effects.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["effect_code", "english", "hindi_current", "hindi_reviewed"])
        for code, (en, hi) in sorted(EFFECTS.items()):
            writer.writerow([code, en, hi, ""])
    return pairs, effects


async def load_into_db(result: LoadResult) -> None:
    import asyncpg

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set (the gateway's read-write URL is needed to seed)")
    conn = await asyncpg.connect(url)
    try:
        async with conn.transaction():
            await conn.executemany(
                UPSERT,
                [
                    (
                        r.salt_a, r.salt_b, r.severity, r.summary, r.source, r.mechanism or None,
                        r.effect_code, r.management_en, r.management_hi, r.hi_reviewed,
                        r.evidence_level or None, r.source_ref, r.source_version,
                    )
                    for r in result.records
                ],
            )  # fmt: skip
            keep_a = [r.salt_a for r in result.records]
            keep_b = [r.salt_b for r in result.records]
            await conn.execute(
                "DELETE FROM interactions i WHERE i.source = $1 AND NOT EXISTS ("
                "SELECT 1 FROM unnest($2::text[], $3::text[]) AS k(a, b) "
                "WHERE k.a = i.salt_a AND k.b = i.salt_b)",
                SOURCE_NAME,
                keep_a,
                keep_b,
            )
    finally:
        await conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--reviewed-hi", default=str(REVIEW / "interactions_hi_reviewed.csv"))
    parser.add_argument("--check", action="store_true", help="parse and report only")
    args = parser.parse_args()

    result = collect(Path(args.reviewed_hi))
    report = write_report(result)
    pairs_csv, effects_csv = write_review_files(result)
    print(
        f"{len(result.records)} interaction pairs ({result.rows_read} core rows, "
        f"{sum(result.rejected.values())} rejected); report: {_shown(report)}"
    )
    print(f"Hindi review files: {_shown(pairs_csv)}, {_shown(effects_csv)}")
    if sum(result.rejected.values()):
        print("REJECTED rows: see the report", file=sys.stderr)
        return 1
    if not args.check:
        asyncio.run(load_into_db(result))
        print(f"upserted {len(result.records)} interactions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
