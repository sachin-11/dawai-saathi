"""Shared helpers for the catalog tests (M8): rows, repositories and the real seed files."""

import importlib.util
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.catalog.repository import DrugRow, InMemoryCatalogRepository
from app.catalog.vector import HashingEmbedder, InMemoryVectorStore
from app.safety.no_substitute import load_policy
from app.tools.drug_matcher import MatcherConfig, match_drug
from app.tools.generic_finder import FinderConfig, MedicineFacts, find_generic

ROOT = Path(__file__).parents[3]
_SCRIPT = ROOT / "data" / "scripts" / "catalog_sources.py"
_spec = importlib.util.spec_from_file_location("catalog_sources", _SCRIPT)
assert _spec and _spec.loader
sources = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sources)

_counter = 0


def row(**overrides: Any) -> DrugRow:
    """A catalog row; override any field. Defaults to an unpriced Dolo-650-like brand."""
    global _counter
    _counter += 1
    values: dict[str, Any] = {
        "id": f"id-{_counter}",
        "brand_name": "Brand",
        "brand_key": "brand",
        "salt_key": "paracetamol",
        "strength_key": "650mg",
        "form_key": "tablet",
        "release_type": "ir",
        "pack_qty": Decimal(10),
        "pack_unit": "tablet",
        "mrp": None,
        "price_per_unit": None,
        "price_source_date": date(2026, 1, 1),
        "is_janaushadhi": False,
        "is_generic": False,
        "source": "test",
    }
    values.update(overrides)
    if "brand_name" in overrides and "brand_key" not in overrides:
        from app.catalog.normalise import brand_key

        values["brand_key"] = brand_key(values["brand_name"])
    if values["mrp"] is not None and values["price_per_unit"] is None:
        values["price_per_unit"] = Decimal(values["mrp"]) / values["pack_qty"]
    return DrugRow(**values)


def seed_rows(*, fixture: bool = True) -> list[DrugRow]:
    """The REAL curated brand list (+ the fictional-price fixture) as catalog rows."""
    results = [sources.load_curated(ROOT / "data" / "seed" / "brands_curated.csv")]
    if fixture:
        results.append(sources.load_fixture(ROOT / "data" / "seed" / "fixture_catalog.csv"))
    return sources.to_drug_rows([r for result in results for r in result.records])


def repo_of(rows: list[DrugRow]) -> InMemoryCatalogRepository:
    return InMemoryCatalogRepository(rows)


async def vector_of(rows: list[DrugRow]) -> InMemoryVectorStore:
    return await InMemoryVectorStore.build(HashingEmbedder(), rows)


async def match_and_find(
    repo: InMemoryCatalogRepository,
    name: str,
    strength: str | None = None,
    form: str | None = None,
    facts: MedicineFacts | None = None,
    *,
    match_config: MatcherConfig | None = None,
    finder_config: FinderConfig | None = None,
):
    match = await match_drug(
        name,
        strength,
        form,
        repo=repo,
        vector=None,
        config=match_config or MatcherConfig(),
    )
    suggestion = await find_generic(
        match,
        facts or MedicineFacts(),
        repo=repo,
        policy=load_policy(),
        config=finder_config or FinderConfig(),
    )
    return match, suggestion
