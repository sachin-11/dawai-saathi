"""Loaders for the medicine catalog sources (M8): one function per source -> `DrugRecord`s.

Every loader returns `(records, rejections)`. A row that cannot be parsed with certainty is REJECTED
with a reason, never guessed; the ingestion report lists the reasons and counts. Normalisation is the
same code the matcher uses (`app/catalog/normalise.py`), so catalog keys and prescription keys agree.

Sources (details, licences and download dates: data/SOURCES.md):
  curated   data/seed/brands_curated.csv  our own brand -> composition list, NO prices
  pmbjp     data/raw/pmbjp/*.csv          Jan Aushadhi product list you downloaded (gitignored)
  brands    a local brand CSV you supply (BRANDS_CSV=...), gitignored, never committed
  fixture   data/seed/fixture_catalog.csv  FICTIONAL prices for tests and demos (refused in production)
"""

import csv
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))

from app.catalog.normalise import brand_key, parse_form, parse_product_name  # noqa: E402
from app.catalog.repository import DrugRow  # noqa: E402

MAX_PRICE_PER_UNIT = Decimal(5000)
MAX_MRP = Decimal(100000)


@dataclass(slots=True)
class DrugRecord:
    source: str
    source_ref: str
    brand_name: str
    brand_key: str
    salt_composition: str
    salt_key: str
    strength: str
    strength_key: str
    form: str
    form_key: str
    release_type: str
    pack_qty: Decimal | None = None
    pack_unit: str | None = None
    pack_size: str | None = None
    mrp: Decimal | None = None
    price_per_unit: Decimal | None = None
    price_source_date: date | None = None
    manufacturer: str | None = None
    is_generic: bool = False
    is_janaushadhi: bool = False
    janaushadhi_code: str | None = None

    def as_csv_row(self) -> dict[str, Any]:
        return {k: ("" if v is None else v) for k, v in asdict(self).items()}


@dataclass(slots=True)
class LoadResult:
    records: list[DrugRecord] = field(default_factory=list)
    rejected: Counter[str] = field(default_factory=Counter)
    rows_read: int = 0
    examples: dict[str, list[str]] = field(default_factory=dict)

    def reject(self, reason: str, example: str) -> None:
        self.rejected[reason] += 1
        bucket = self.examples.setdefault(reason, [])
        if len(bucket) < 3:
            bucket.append(example[:80])


def to_drug_rows(records: list[DrugRecord]) -> list[DrugRow]:
    """Seed records as catalog rows (what the matcher reads): tests and evals run without a database."""
    return [
        DrugRow(
            id=f"{r.source[:12]}|{r.source_ref}",
            brand_name=r.brand_name,
            brand_key=r.brand_key,
            salt_key=r.salt_key,
            strength_key=r.strength_key,
            form_key=r.form_key,
            release_type=r.release_type,
            pack_qty=r.pack_qty,
            pack_unit=r.pack_unit,
            mrp=r.mrp,
            price_per_unit=r.price_per_unit,
            price_source_date=r.price_source_date,
            is_janaushadhi=r.is_janaushadhi,
            is_generic=r.is_generic,
            source=r.source,
        )
        for r in records
    ]


# ---------------------------------------------------------------- helpers

_PACK_RE = re.compile(
    r"(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>'?s\b|tablets?|tabs?|capsules?|caps?|ml|gm|g\b|vials?|"
    r"ampoules?|amps?|pens?|cartridges?|strips?)",
    re.IGNORECASE,
)


def parse_pack(text: str | None, form_key: str) -> tuple[Decimal | None, str | None]:
    """`10's` / `10 Tablets` / `60 ml` / `1 vial` -> (quantity, unit); (None, None) when unclear."""
    if not text:
        return None, None
    match = _PACK_RE.search(text)
    if not match:
        return None, None
    qty = Decimal(match.group("qty"))
    unit = match.group("unit").lower()
    if qty <= 0:
        return None, None
    if unit.startswith(("tab", "'s")) or unit == "s":
        unit = (
            "tablet"
            if form_key in {"tablet", "other"}
            else ("capsule" if form_key == "capsule" else "unit")
        )
    elif unit.startswith("cap"):
        unit = "capsule"
    elif unit in {"gm", "g"}:
        unit = "g"
    elif unit.startswith(("vial", "amp", "pen", "cart")):
        unit = "vial"
    elif unit.startswith("strip"):
        return None, None  # "strip" has no fixed size
    return qty, unit


def parse_money(text: str | None) -> Decimal | None:
    """`12.50`, `₹ 1,250.00`, `Rs. 30` -> Decimal. Takes the FIRST number: stripping every non-digit
    would turn "Rs. 30" into ".30"."""
    if text is None:
        return None
    match = re.search(r"\d[\d,]*(?:\.\d+)?", str(text))
    if not match:
        return None
    try:
        value = Decimal(match.group(0).replace(",", ""))
    except InvalidOperation:
        return None
    return value if value > 0 else None


def price_per_unit(mrp: Decimal | None, qty: Decimal | None) -> Decimal | None:
    if mrp is None or qty is None or qty <= 0:
        return None
    return (mrp / qty).quantize(Decimal("0.0001"))


_FORM_WORD = {
    "tablet": "tablet", "capsule": "capsule", "syrup": "syrup", "suspension": "suspension",
    "injection": "injection", "drops": "drops", "cream": "cream", "gel": "gel", "inhaler": "inhaler",
}  # fmt: skip
_RELEASE_WORD = {
    "sr": "SR", "er": "ER", "xr": "XR", "cr": "CR", "mr": "MR", "dr": "gastro-resistant",
}  # fmt: skip


def form_words(*texts: str) -> str | None:
    """ "Dolo 650 Tablet" / "Glycomet SR 500" -> "tablet" / "tablet SR": only FORM words, never the
    brand. None when the form cannot be told (a brand list without it is rejected, not guessed)."""
    for text in texts:
        form, release = parse_form(text)
        if form in _FORM_WORD:
            return f"{_FORM_WORD[form]} {_RELEASE_WORD.get(release, '')}".strip()
    return None


def _header_map(fieldnames: list[str], wanted: dict[str, tuple[str, ...]]) -> dict[str, str]:
    """Map our field names to the file's headers, tolerant of case, spaces and punctuation."""
    cleaned = {re.sub(r"[^a-z0-9]", "", name.lower()): name for name in fieldnames}
    found: dict[str, str] = {}
    for key, options in wanted.items():
        for option in options:
            target = re.sub(r"[^a-z0-9]", "", option)
            if target in cleaned:
                found[key] = cleaned[target]
                break
        else:
            for option in options:
                target = re.sub(r"[^a-z0-9]", "", option)
                hit = next((orig for clean, orig in cleaned.items() if target in clean), None)
                if hit:
                    found[key] = hit
                    break
    return found


def _record_from_parsed(
    result: LoadResult,
    *,
    source: str,
    ref: str,
    brand: str,
    product_text: str,
    mrp: Decimal | None,
    pack_text: str | None,
    price_date: date | None,
    is_generic: bool,
    is_ja: bool,
    code: str | None,
    require_price: bool,
    manufacturer: str | None = None,
) -> None:
    parsed = parse_product_name(product_text)
    if parsed is None:
        result.reject("composition_or_strength_unparseable", product_text)
        return
    qty, unit = parse_pack(pack_text, parsed.form_key)
    price = None
    if mrp is not None:
        if mrp > MAX_MRP:
            result.reject("implausible_price", f"{brand} {mrp}")
            return
        price = price_per_unit(mrp, qty)
        if price is not None and price > MAX_PRICE_PER_UNIT:
            result.reject("implausible_price", f"{brand} {price}")
            return
    if require_price and (mrp is None or price is None):
        result.reject("missing_price_or_pack", f"{brand} mrp={mrp} pack={pack_text}")
        return
    result.records.append(
        DrugRecord(
            source=source,
            source_ref=ref,
            brand_name=brand,
            brand_key=brand_key(brand),
            salt_composition=" + ".join(parsed.salts),
            salt_key=parsed.salt_key,
            strength=parsed.strength_key,
            strength_key=parsed.strength_key,
            form=product_text,
            form_key=parsed.form_key,
            release_type=parsed.release_type,
            pack_qty=qty,
            pack_unit=unit,
            pack_size=pack_text,
            mrp=mrp,
            price_per_unit=price,
            price_source_date=price_date,
            manufacturer=manufacturer,
            is_generic=is_generic,
            is_janaushadhi=is_ja,
            janaushadhi_code=code,
        )
    )


# ---------------------------------------------------------------- sources


def load_curated(
    path: Path, source_label: str = "curated-brands-v1 (own list, unreviewed, no prices)"
) -> LoadResult:
    """brand_name, composition (salt + strength each), form -> brand rows WITHOUT prices."""
    result = LoadResult()
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            result.rows_read += 1
            brand = row["brand_name"].strip()
            text = f"{row['composition'].strip()} {row['form'].strip()}"
            _record_from_parsed(
                result,
                source=source_label,
                ref=f"{brand_key(brand)}|{row['composition'].strip().lower()}|{row['form'].strip().lower()}",
                brand=brand,
                product_text=text,
                mrp=None,
                pack_text=None,
                price_date=None,
                is_generic=False,
                is_ja=False,
                code=None,
                require_price=False,
            )
    return result


def load_pmbjp(directory: Path, price_date: date, source_label: str) -> LoadResult:
    """Jan Aushadhi product list exported to CSV: drug code, generic name, unit size, MRP."""
    result = LoadResult()
    wanted = {
        "code": ("drug code", "drugcode", "code", "product code"),
        "name": (
            "generic name",
            "name of medicine",
            "product name",
            "medicine name",
            "generic_name",
        ),
        "unit": ("unit size", "unit_size", "pack size", "pack"),
        "mrp": ("mrp", "mrp in rs", "mrp (rs)", "price"),
    }
    for path in sorted(directory.glob("*.csv")):
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            headers = _header_map(list(reader.fieldnames or []), wanted)
            missing = [k for k in wanted if k not in headers]
            if missing:
                raise SystemExit(
                    f"{path.name}: cannot find columns for {missing} in {reader.fieldnames}"
                )
            for row in reader:
                result.rows_read += 1
                name = (row[headers["name"]] or "").strip()
                code = (row[headers["code"]] or "").strip()
                if not name or not code:
                    result.reject("missing_name_or_code", name or code or "(empty row)")
                    continue
                _record_from_parsed(
                    result,
                    source=source_label,
                    ref=code,
                    brand=name,
                    product_text=name,
                    mrp=parse_money(row[headers["mrp"]]),
                    pack_text=row[headers["unit"]],
                    price_date=price_date,
                    is_generic=True,
                    is_ja=True,
                    code=code,
                    require_price=True,
                )
    return result


def load_local_brands(path: Path, price_date: date, source_label: str) -> LoadResult:
    """A brand dataset YOU supply (gitignored, local use only): brand, composition, pack size, price."""
    result = LoadResult()
    wanted = {
        "brand": ("name", "brand", "brand name", "medicine name", "product name"),
        "composition": ("composition", "salt composition", "salt_composition", "short composition"),
        "pack": ("pack size", "pack_size", "pack", "unit size"),
        "mrp": ("price", "mrp", "price(₹)", "price inr"),
        "maker": ("manufacturer", "manufacturer name", "company"),
        "form": ("type", "form", "dosage form"),
    }
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = _header_map(list(reader.fieldnames or []), wanted)
        for needed in ("brand", "composition", "mrp"):
            if needed not in headers:
                raise SystemExit(
                    f"{path.name}: no column found for {needed!r} in {reader.fieldnames}"
                )
        for index, row in enumerate(reader):
            result.rows_read += 1
            brand = (row[headers["brand"]] or "").strip()
            composition = (row[headers["composition"]] or "").strip()
            form = (row.get(headers.get("form", ""), "") or "").strip()
            words = form_words(form, brand)
            if words is None:
                result.reject("form_unknown", brand)
                continue
            _record_from_parsed(
                result,
                source=source_label,
                ref=f"{index}:{brand_key(brand)}",
                brand=brand,
                product_text=f"{composition} {words}",
                mrp=parse_money(row[headers["mrp"]]),
                pack_text=row.get(headers.get("pack", ""), None),
                price_date=price_date,
                is_generic=False,
                is_ja=False,
                code=None,
                require_price=True,
                manufacturer=(row.get(headers.get("maker", ""), "") or None),
            )
    return result


def load_fixture(path: Path) -> LoadResult:
    """FICTIONAL catalog with made-up prices: tests and demos only."""
    result = LoadResult()
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            result.rows_read += 1
            is_ja = row["kind"] == "ja"
            _record_from_parsed(
                result,
                source="test-fixture-fictional-prices",
                ref=row["ref"],
                brand=row["brand_name"],
                product_text=row["product"],
                mrp=parse_money(row["mrp"]),
                pack_text=row["pack"],
                price_date=date(2026, 1, 1),
                is_generic=is_ja,
                is_ja=is_ja,
                code=row["ref"] if is_ja else None,
                require_price=False,
            )
    return result
