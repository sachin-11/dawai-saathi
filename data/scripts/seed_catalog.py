"""Build the medicine catalog CSV, write an ingestion report and (optionally) upsert into Postgres.

  make seed                                  curated brands (+ Jan Aushadhi if data/raw/pmbjp/*.csv exists)
  make seed FIXTURE=1                        ... plus FICTIONAL prices for demos/tests (never in production)
  make seed BRANDS_CSV=data/raw/brands.csv   ... plus a brand dataset you supply (local only, gitignored)
  make seed PMBJP_DATE=2026-01-31            required when Jan Aushadhi files are present

Idempotent: rows are upserted on (source, source_ref), so running it twice changes nothing. Every
price carries `price_source_date`. See data/SOURCES.md for the sources and their (unverified) terms.
"""

import argparse
import asyncio
import csv
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from catalog_sources import (  # noqa: E402
    ROOT,
    DrugRecord,
    LoadResult,
    load_curated,
    load_fixture,
    load_local_brands,
    load_pmbjp,
)

from app.catalog.salt_aliases import SALT_ALIASES  # noqa: E402

SEED = ROOT / "data" / "seed"
RAW = ROOT / "data" / "raw"
REPORTS = Path(os.environ.get("SEED_REPORT_DIR", ROOT / "data" / "reports"))

UPSERT = """
INSERT INTO drugs (
  brand_name, brand_key, salt_composition, strength, form, salt_key, strength_key, form_key,
  release_type, pack_size, pack_qty, pack_unit, mrp, price_per_unit, price_source_date, manufacturer,
  is_generic, is_janaushadhi, janaushadhi_code, source, source_ref
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::release_type,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
ON CONFLICT (source, source_ref) DO UPDATE SET
  brand_name=EXCLUDED.brand_name, brand_key=EXCLUDED.brand_key,
  salt_composition=EXCLUDED.salt_composition, strength=EXCLUDED.strength, form=EXCLUDED.form,
  salt_key=EXCLUDED.salt_key, strength_key=EXCLUDED.strength_key, form_key=EXCLUDED.form_key,
  release_type=EXCLUDED.release_type, pack_size=EXCLUDED.pack_size, pack_qty=EXCLUDED.pack_qty,
  pack_unit=EXCLUDED.pack_unit, mrp=EXCLUDED.mrp, price_per_unit=EXCLUDED.price_per_unit,
  price_source_date=EXCLUDED.price_source_date, manufacturer=EXCLUDED.manufacturer,
  is_generic=EXCLUDED.is_generic, is_janaushadhi=EXCLUDED.is_janaushadhi,
  janaushadhi_code=EXCLUDED.janaushadhi_code
"""


def _shown(path: Path) -> Path:
    """A path relative to the repo when it is inside it (reports can be redirected with SEED_REPORT_DIR)."""
    return path.relative_to(ROOT) if path.is_relative_to(ROOT) else path


def collect(args: argparse.Namespace) -> list[tuple[str, LoadResult]]:
    results: list[tuple[str, LoadResult]] = [
        ("curated brands", load_curated(SEED / "brands_curated.csv"))
    ]

    pmbjp_dir = Path(args.pmbjp_dir)
    if list(pmbjp_dir.glob("*.csv")):
        if not args.pmbjp_date:
            raise SystemExit(
                "data/raw/pmbjp has files: pass PMBJP_DATE=YYYY-MM-DD (the list's own date)"
            )
        price_date = date.fromisoformat(args.pmbjp_date)
        label = f"PMBJP product list (Jan Aushadhi), downloaded {args.pmbjp_date}, terms unverified"
        results.append(("Jan Aushadhi (PMBJP)", load_pmbjp(pmbjp_dir, price_date, label)))
    else:
        print(
            f"note: no Jan Aushadhi CSV in {pmbjp_dir}: no generic alternatives will exist",
            file=sys.stderr,
        )

    if args.brands_csv:
        stamp = args.brands_date or date.today().isoformat()
        label = f"local brand dataset {Path(args.brands_csv).name} (licence unverified, local only)"
        results.append(
            (
                "local brand CSV",
                load_local_brands(Path(args.brands_csv), date.fromisoformat(stamp), label),
            )
        )

    if args.fixture:
        if os.environ.get("NODE_ENV") == "production":
            raise SystemExit("the fictional-price fixture must never be loaded in production")
        results.append(("FICTIONAL fixture", load_fixture(SEED / "fixture_catalog.csv")))
    return results


def dedupe(results: list[tuple[str, LoadResult]]) -> tuple[list[DrugRecord], int]:
    seen: dict[tuple[str, str], DrugRecord] = {}
    duplicates = 0
    for _, result in results:
        for record in result.records:
            key = (record.source, record.source_ref)
            if key in seen:
                duplicates += 1
            seen[key] = record
    return list(seen.values()), duplicates


def write_csv(records: list[DrugRecord], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        rows = [r.as_csv_row() for r in records]
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else ["source"])
        writer.writeheader()
        writer.writerows(rows)


def write_report(results: list[tuple[str, LoadResult]], accepted: int, duplicates: int) -> Path:
    REPORTS.mkdir(parents=True, exist_ok=True)
    lines = [f"# Catalog ingestion report ({date.today().isoformat()})", ""]
    for name, result in results:
        lines += [
            f"## {name}",
            "",
            f"- rows read: {result.rows_read}",
            f"- accepted: {len(result.records)}",
            f"- rejected: {sum(result.rejected.values())}",
        ]
        for reason, count in result.rejected.most_common():
            examples = "; ".join(result.examples.get(reason, []))
            lines.append(f"  - {reason}: {count} (e.g. {examples})")
        lines.append("")
    lines += [
        f"Total rows after de-duplication: {accepted} ({duplicates} duplicates replaced).",
        "",
    ]
    target = REPORTS / f"{date.today().isoformat()}-ingestion.md"
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


async def load_into_db(records: list[DrugRecord]) -> None:
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
                        r.brand_name, r.brand_key, r.salt_composition, r.strength, r.form, r.salt_key,
                        r.strength_key, r.form_key, r.release_type, r.pack_size, r.pack_qty, r.pack_unit,
                        r.mrp, r.price_per_unit, r.price_source_date, r.manufacturer, r.is_generic,
                        r.is_janaushadhi, r.janaushadhi_code, r.source, r.source_ref,
                    )
                    for r in records
                ],
            )  # fmt: skip
            await conn.executemany(
                "INSERT INTO salt_aliases (alias, canonical) VALUES ($1, $2) "
                "ON CONFLICT (alias) DO UPDATE SET canonical = EXCLUDED.canonical",
                sorted(SALT_ALIASES.items()),
            )
    finally:
        await conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--pmbjp-dir", default=str(RAW / "pmbjp"))
    parser.add_argument("--pmbjp-date")
    parser.add_argument("--brands-csv")
    parser.add_argument("--brands-date")
    parser.add_argument("--fixture", action="store_true")
    parser.add_argument("--out", default=str(SEED / "drugs.csv"))
    parser.add_argument("--load", action="store_true", help="upsert into DATABASE_URL")
    args = parser.parse_args()

    results = collect(args)
    records, duplicates = dedupe(results)
    write_csv(records, Path(args.out))
    report = write_report(results, len(records), duplicates)
    print(f"{len(records)} catalog rows -> {args.out}; report: {_shown(report)}")
    for name, result in results:
        print(
            f"  {name}: read {result.rows_read}, accepted {len(result.records)}, rejected {sum(result.rejected.values())}"
        )
    if args.load:
        asyncio.run(load_into_db(records))
        print(f"upserted {len(records)} drugs and {len(SALT_ALIASES)} salt aliases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
