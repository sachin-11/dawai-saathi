"""Read access to the catalog (`drugs`), behind a small interface (M8).

`PgCatalogRepository` runs against the read-only Postgres session (pg_trgm for fuzzy brand names).
`InMemoryCatalogRepository` has the same behaviour on a list of rows, with a Python re-implementation
of pg_trgm's similarity, so unit tests, the eval and fake mode need no database.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


@dataclass(frozen=True, slots=True)
class DrugRow:
    id: str
    brand_name: str
    brand_key: str
    salt_key: str
    strength_key: str
    form_key: str
    release_type: str
    pack_qty: Decimal | None = None
    pack_unit: str | None = None
    mrp: Decimal | None = None
    price_per_unit: Decimal | None = None
    price_source_date: date | None = None
    is_janaushadhi: bool = False
    is_generic: bool = False
    source: str = ""

    @property
    def key(self) -> tuple[str, str, str, str]:
        return (self.salt_key, self.strength_key, self.form_key, self.release_type)


class CatalogRepository(Protocol):
    async def exact_brand(self, brand_key: str) -> list[DrugRow]: ...
    async def trgm_brand(
        self, brand_key: str, min_similarity: float, limit: int
    ) -> list[tuple[DrugRow, float]]: ...
    async def prefix_brand(self, prefix: str, limit: int) -> list[DrugRow]: ...
    async def by_salt(self, salt_key: str, strength_key: str) -> list[DrugRow]: ...
    async def alternatives(
        self, salt_key: str, strength_key: str, form_key: str, release_type: str
    ) -> list[DrugRow]: ...
    async def by_ids(self, ids: list[str]) -> list[DrugRow]: ...
    async def all_rows(self) -> list[DrugRow]: ...


# ---------------------------------------------------------------- trigram similarity (pg_trgm)


def trigrams(value: str) -> set[str]:
    """pg_trgm: lower-case, non-alphanumerics separate words, each word padded with two spaces in
    front and one behind, then cut into 3-character pieces."""
    grams: set[str] = set()
    for word in re.sub(r"[^a-z0-9]+", " ", value.lower()).split():
        padded = f"  {word} "
        grams.update(padded[i : i + 3] for i in range(len(padded) - 2))
    return grams


def similarity(a: str, b: str) -> float:
    ta, tb = trigrams(a), trigrams(b)
    union = len(ta | tb)
    return len(ta & tb) / union if union else 0.0


# ---------------------------------------------------------------- in memory


def _priced_first(rows: Iterable[DrugRow]) -> list[DrugRow]:
    return sorted(rows, key=lambda r: (r.price_per_unit is None, r.brand_name))


class InMemoryCatalogRepository:
    def __init__(self, rows: Iterable[DrugRow]) -> None:
        self._rows = list(rows)

    async def exact_brand(self, brand_key: str) -> list[DrugRow]:
        return _priced_first(r for r in self._rows if r.brand_key == brand_key)

    async def trgm_brand(
        self, brand_key: str, min_similarity: float, limit: int
    ) -> list[tuple[DrugRow, float]]:
        scored = [(r, similarity(r.brand_key, brand_key)) for r in self._rows if r.brand_key]
        hits = [(r, s) for r, s in scored if s >= min_similarity]
        hits.sort(key=lambda pair: (-pair[1], pair[0].price_per_unit is None))
        return hits[:limit]

    async def prefix_brand(self, prefix: str, limit: int) -> list[DrugRow]:
        return _priced_first(r for r in self._rows if r.brand_key.startswith(prefix))[:limit]

    async def by_salt(self, salt_key: str, strength_key: str) -> list[DrugRow]:
        return _priced_first(
            r for r in self._rows if r.salt_key == salt_key and r.strength_key == strength_key
        )

    async def alternatives(
        self, salt_key: str, strength_key: str, form_key: str, release_type: str
    ) -> list[DrugRow]:
        return [
            r
            for r in self._rows
            if r.key == (salt_key, strength_key, form_key, release_type)
            and r.price_per_unit is not None
        ]

    async def by_ids(self, ids: list[str]) -> list[DrugRow]:
        wanted = set(ids)
        return [r for r in self._rows if r.id in wanted]

    async def all_rows(self) -> list[DrugRow]:
        return list(self._rows)


# ---------------------------------------------------------------- postgres

_COLUMNS = (
    "id::text AS id, brand_name, brand_key, salt_key, strength_key, form_key, release_type::text "
    "AS release_type, pack_qty, pack_unit, mrp, price_per_unit, price_source_date, is_janaushadhi, "
    "is_generic, source"
)
_BASE = f"SELECT {_COLUMNS} FROM drugs WHERE salt_key IS NOT NULL AND strength_key IS NOT NULL"
_ORDER = "ORDER BY price_per_unit NULLS LAST, brand_name"


def _row(mapping: object) -> DrugRow:
    m = dict(mapping)  # type: ignore[call-overload]
    return DrugRow(**{k: m[k] for k in DrugRow.__dataclass_fields__})


class PgCatalogRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory

    async def _fetch(self, sql: str, params: dict[str, object]) -> list[dict[str, object]]:
        async with self._sessions() as session:
            result = await session.execute(text(sql), params)
            return [dict(r) for r in result.mappings().all()]

    async def exact_brand(self, brand_key: str) -> list[DrugRow]:
        rows = await self._fetch(f"{_BASE} AND brand_key = :k {_ORDER}", {"k": brand_key})
        return [_row(r) for r in rows]

    async def trgm_brand(
        self, brand_key: str, min_similarity: float, limit: int
    ) -> list[tuple[DrugRow, float]]:
        rows = await self._fetch(
            f"SELECT {_COLUMNS}, similarity(brand_key, :k) AS sim FROM drugs "
            "WHERE salt_key IS NOT NULL AND strength_key IS NOT NULL AND brand_key % :k "
            "AND similarity(brand_key, :k) >= :min "
            "ORDER BY sim DESC, price_per_unit NULLS LAST LIMIT :n",
            {"k": brand_key, "min": min_similarity, "n": limit},
        )
        return [(_row({**r, "id": r["id"]}), float(r["sim"])) for r in rows]  # type: ignore[arg-type]

    async def prefix_brand(self, prefix: str, limit: int) -> list[DrugRow]:
        rows = await self._fetch(
            f"{_BASE} AND brand_key LIKE :pattern {_ORDER} LIMIT :n",
            {"pattern": f"{prefix}%", "n": limit},
        )
        return [_row(r) for r in rows]

    async def by_salt(self, salt_key: str, strength_key: str) -> list[DrugRow]:
        rows = await self._fetch(
            f"{_BASE} AND salt_key = :s AND strength_key = :t {_ORDER}",
            {"s": salt_key, "t": strength_key},
        )
        return [_row(r) for r in rows]

    async def alternatives(
        self, salt_key: str, strength_key: str, form_key: str, release_type: str
    ) -> list[DrugRow]:
        rows = await self._fetch(
            f"{_BASE} AND salt_key = :s AND strength_key = :t AND form_key = :f "
            "AND release_type = CAST(:r AS release_type) AND price_per_unit IS NOT NULL "
            f"{_ORDER}",
            {"s": salt_key, "t": strength_key, "f": form_key, "r": release_type},
        )
        return [_row(r) for r in rows]

    async def by_ids(self, ids: list[str]) -> list[DrugRow]:
        if not ids:
            return []
        rows = await self._fetch(f"{_BASE} AND id::text = ANY(:ids) {_ORDER}", {"ids": list(ids)})
        return [_row(r) for r in rows]

    async def all_rows(self) -> list[DrugRow]:
        return [_row(r) for r in await self._fetch(f"{_BASE} {_ORDER}", {})]
