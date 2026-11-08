"""Read access to the `interactions` table, behind a small interface (M11).

`PgInteractionRepository` runs on the read-only session; `InMemoryInteractionRepository` has the same
behaviour on a list of rows so unit tests, the eval and fake mode need no database. A pair is stored
once with `salt_a < salt_b`; callers pass pairs in any order, the repositories normalise.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


@dataclass(frozen=True, slots=True)
class InteractionRow:
    id: str
    salt_a: str
    salt_b: str
    severity: str  # minor | moderate | major
    effect_code: str
    summary: str
    management_en: str
    management_hi: str
    hi_reviewed: bool
    source: str
    source_ref: str | None = None
    source_version: str | None = None


def ordered(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a <= b else (b, a)


class InteractionRepository(Protocol):
    async def pairs(self, pairs: Iterable[tuple[str, str]]) -> list[InteractionRow]: ...
    async def known_salts(self) -> frozenset[str]: ...


class InMemoryInteractionRepository:
    def __init__(self, rows: Iterable[InteractionRow]) -> None:
        self._by_pair = {(r.salt_a, r.salt_b): r for r in rows}

    async def pairs(self, pairs: Iterable[tuple[str, str]]) -> list[InteractionRow]:
        wanted = {ordered(a, b) for a, b in pairs}
        return [self._by_pair[p] for p in sorted(wanted) if p in self._by_pair]

    async def known_salts(self) -> frozenset[str]:
        return frozenset(s for pair in self._by_pair for s in pair)

    def all_rows(self) -> list[InteractionRow]:
        return list(self._by_pair.values())


class FailingInteractionRepository:
    """Always raises: for tests of the "database down is not 'no interaction'" rule."""

    async def pairs(self, pairs: Iterable[tuple[str, str]]) -> list[InteractionRow]:
        raise ConnectionError("interaction database unavailable")

    async def known_salts(self) -> frozenset[str]:
        raise ConnectionError("interaction database unavailable")


_COLUMNS = (
    "i.id::text AS id, i.salt_a, i.salt_b, i.severity::text AS severity, i.effect_code, "
    "i.summary, i.management_en, i.management_hi, i.hi_reviewed, i.source, i.source_ref, "
    "i.source_version"
)


class PgInteractionRepository:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory

    async def pairs(self, pairs: Iterable[tuple[str, str]]) -> list[InteractionRow]:
        wanted = sorted({ordered(a, b) for a, b in pairs})
        if not wanted:
            return []
        sql = (
            f"SELECT {_COLUMNS} FROM interactions i "  # noqa: S608 - constants only
            "JOIN unnest(CAST(:a AS text[]), CAST(:b AS text[])) AS p(a, b) "
            "ON i.salt_a = p.a AND i.salt_b = p.b ORDER BY i.salt_a, i.salt_b"
        )
        params = {"a": [a for a, _ in wanted], "b": [b for _, b in wanted]}
        async with self._sessions() as session:
            result = await session.execute(text(sql), params)
            rows = [dict(r) for r in result.mappings().all()]
        fields = InteractionRow.__dataclass_fields__
        return [InteractionRow(**{k: r[k] for k in fields}) for r in rows]

    async def known_salts(self) -> frozenset[str]:
        sql = "SELECT salt_a AS s FROM interactions UNION SELECT salt_b FROM interactions"
        async with self._sessions() as session:
            result = await session.execute(text(sql))
            return frozenset(str(row[0]) for row in result.all())
