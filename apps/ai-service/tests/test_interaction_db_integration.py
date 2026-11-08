"""The Postgres interaction repository against a REAL database (docker-compose.test.yml), M11.

    make test-integration                    # starts the stack, runs everything, cleans up
    uv run pytest -m integration             # with the stack running and migrated

Seeds the committed core list as the admin role, reads it back as the READ-ONLY service role, and
checks that `PgInteractionRepository` (unnest join, enum cast) answers exactly like the in-memory
one the unit tests and the eval use, that the full pipeline works on top of it, and that the AI
role cannot write.
"""

import os
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import load_settings
from app.db.session import Database
from app.interactions.repository import InMemoryInteractionRepository, PgInteractionRepository
from app.interactions.service import InteractionService
from tests.interaction_support import core_rows, med

pytestmark = pytest.mark.integration

RO_URL = os.environ.get(
    "INTEGRATION_AI_DATABASE_URL", "postgresql://dawai_ai_ro:dawai_ai_ro@localhost:5543/dawai_test"
)
ADMIN_URL = os.environ.get(
    "INTEGRATION_DATABASE_URL", "postgresql://dawai:dawai@localhost:5543/dawai_test"
)
TEST_SOURCE = "m11-int-test"


def _asyncpg(url: str) -> str:
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


@pytest.fixture
async def seeded() -> AsyncIterator[None]:
    assert ADMIN_URL.rsplit("/", 1)[-1].endswith("_test"), (
        "refusing to run outside a *_test database"
    )
    engine: AsyncEngine = create_async_engine(_asyncpg(ADMIN_URL))
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM interactions"))
        for row in core_rows():
            await conn.execute(
                text(
                    "INSERT INTO interactions (salt_a, salt_b, severity, summary, source, "
                    "effect_code, management_en, management_hi, hi_reviewed, source_ref, "
                    "source_version) VALUES (:a, :b, CAST(:sev AS interaction_severity), :sum, "
                    ":src, :eff, :men, :mhi, :rev, :ref, :ver)"
                ),
                {
                    "a": row.salt_a, "b": row.salt_b, "sev": row.severity, "sum": row.summary,
                    "src": TEST_SOURCE, "eff": row.effect_code, "men": row.management_en,
                    "mhi": row.management_hi, "rev": row.hi_reviewed, "ref": row.source_ref,
                    "ver": row.source_version,
                },
            )  # fmt: skip
    yield
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM interactions WHERE source = :s"), {"s": TEST_SOURCE})
    await engine.dispose()


@pytest.fixture
async def database() -> AsyncIterator[Database]:
    settings = load_settings(
        _env_file=None, NODE_ENV="test", LOG_LEVEL="silent", SERVICE_TOKEN="test-service-token",
        AI_DATABASE_URL=RO_URL,
    )  # fmt: skip
    db = Database(settings)
    yield db
    await db.dispose()


PAIRS = [
    ("warfarin", "ibuprofen"),  # given in the wrong order on purpose
    ("diclofenac", "warfarin"),
    ("clopidogrel", "omeprazole"),
    ("paracetamol", "metformin"),  # no row
    ("escitalopram", "tramadol"),
    ("levothyroxine", "calcium carbonate"),
    ("nothing", "here"),
]


async def test_the_ai_role_reads_interactions_but_cannot_write(seeded, database) -> None:
    repo = PgInteractionRepository(database.session_factory)
    assert await repo.pairs([("ibuprofen", "warfarin")])
    async with database.session_factory() as session:
        with pytest.raises(Exception, match=r"read-only|permission denied"):
            await session.execute(text("UPDATE interactions SET summary = summary"))
    async with database.session_factory() as session:  # a fresh transaction
        with pytest.raises(Exception, match=r"permission denied"):
            await session.execute(text("SELECT * FROM medication_warnings"))  # not its table


async def test_postgres_and_memory_repositories_agree(seeded, database) -> None:
    pg = PgInteractionRepository(database.session_factory)
    memory = InMemoryInteractionRepository(core_rows())

    def shape(rows):
        return [(r.salt_a, r.salt_b, r.severity, r.effect_code) for r in rows]

    assert shape(await pg.pairs(PAIRS)) == shape(await memory.pairs(PAIRS))
    assert await pg.pairs([]) == []
    rows = await pg.pairs([("ibuprofen", "warfarin")])
    assert rows[0].source == TEST_SOURCE and rows[0].hi_reviewed is False
    assert rows[0].management_hi  # the safe generic Hindi line is stored


async def test_known_salts_cover_both_columns(seeded, database) -> None:
    pg = PgInteractionRepository(database.session_factory)
    memory = InMemoryInteractionRepository(core_rows())
    known = await pg.known_salts()
    assert known == await memory.known_salts()
    assert {"warfarin", "ibuprofen", "levothyroxine"} <= known


async def test_the_checker_gives_the_same_report_on_both_repositories(seeded, database) -> None:
    pg_service = InteractionService(PgInteractionRepository(database.session_factory))
    memory_service = InteractionService(InMemoryInteractionRepository(core_rows()))
    medications = [
        med("rx:0", "ibuprofen+paracetamol", "Combiflam"),
        med("rx:1", "warfarin", "Warf"),
        med("s1", "paracetamol", "Dolo 650", new=False),
        med("s2", "levothyroxine", "Eltroxin", new=False),
        med("s3", "calcium carbonate", "Shelcal", new=False),
    ]
    a = await pg_service.check(medications, only_new=False)
    b = await memory_service.check(medications, only_new=False)
    key = lambda f: (f.type, f.salt_a, f.salt_b, f.severity, tuple(f.medication_refs))  # noqa: E731
    assert [key(f) for f in a.findings] == [key(f) for f in b.findings]
    assert a.database_ok and b.database_ok
    kinds = {(f.type, f.salt_a, f.salt_b) for f in a.findings}
    assert ("duplicate_ingredient", "paracetamol", "paracetamol") in kinds
    assert ("interaction", "calcium carbonate", "levothyroxine") in kinds
    assert ("interaction", "ibuprofen", "warfarin") in kinds


async def test_a_dead_database_is_reported_not_swallowed() -> None:
    settings = load_settings(
        _env_file=None, NODE_ENV="test", LOG_LEVEL="silent", SERVICE_TOKEN="test-service-token",
        AI_DATABASE_URL="postgresql://nobody:nothing@localhost:1/none",
    )  # fmt: skip
    db = Database(settings)
    try:
        service = InteractionService(PgInteractionRepository(db.session_factory))
        report = await service.check([med("a", "ibuprofen"), med("b", "warfarin")])
        assert report.database_ok is False and report.findings == []
        assert await service.known_salts() == frozenset()
    finally:
        await db.dispose()
