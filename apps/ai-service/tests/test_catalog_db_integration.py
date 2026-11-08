"""The Postgres catalog repository against a REAL database (docker-compose.test.yml), M8.

    make test-integration                    # starts the stack, runs everything, cleans up
    uv run pytest -m integration             # with the stack running and migrated

Seeds the curated brands + the fictional-price fixture as the admin role, reads them back as the
READ-ONLY service role, and checks that the Postgres repository (pg_trgm, LIKE, the four-key query)
behaves exactly like the in-memory one the unit tests and the eval use.
"""

import asyncio
import os
import sys
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.catalog.repository import InMemoryCatalogRepository, PgCatalogRepository
from app.catalog.service import CatalogService
from app.config import load_settings
from app.db.session import Database
from app.tools.generic_finder import MedicineFacts
from tests.catalog_support import ROOT, seed_rows

pytestmark = pytest.mark.integration

RO_URL = os.environ.get(
    "INTEGRATION_AI_DATABASE_URL", "postgresql://dawai_ai_ro:dawai_ai_ro@localhost:5543/dawai_test"
)
ADMIN_URL = os.environ.get(
    "INTEGRATION_DATABASE_URL", "postgresql://dawai:dawai@localhost:5543/dawai_test"
)
TEST_SOURCE = "m8-int-test"


def _asyncpg(url: str) -> str:
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


@pytest.fixture
async def seeded() -> AsyncIterator[None]:
    """Insert the seed rows with a private `source` (so nothing else in the test DB is touched)."""
    assert ADMIN_URL.rsplit("/", 1)[-1].endswith("_test"), (
        "refusing to run outside a *_test database"
    )
    engine: AsyncEngine = create_async_engine(_asyncpg(ADMIN_URL))
    rows = seed_rows()
    async with engine.begin() as conn:
        # A throwaway *_test database: start from an empty catalog so no earlier seed run leaks in.
        await conn.execute(text("DELETE FROM drugs"))
        for r in rows:
            await conn.execute(
                text(
                    "INSERT INTO drugs (id, brand_name, brand_key, salt_composition, strength, form, "
                    "salt_key, strength_key, form_key, release_type, pack_qty, pack_unit, mrp, "
                    "price_per_unit, price_source_date, is_generic, is_janaushadhi, source, source_ref) "
                    "VALUES (CAST(:id AS uuid), :bn, :bk, :sc, :st, :fo, :sk, :stk, :fk, "
                    "CAST(:rt AS release_type), :pq, :pu, :mrp, :ppu, :psd, :ig, :ij, :src, :ref)"
                ),
                {
                    "id": _uuid_for(r.id), "bn": r.brand_name, "bk": r.brand_key, "sc": r.salt_key,
                    "st": r.strength_key, "fo": r.form_key, "sk": r.salt_key, "stk": r.strength_key,
                    "fk": r.form_key, "rt": r.release_type, "pq": r.pack_qty, "pu": r.pack_unit,
                    "mrp": r.mrp, "ppu": r.price_per_unit, "psd": r.price_source_date,
                    "ig": r.is_generic, "ij": r.is_janaushadhi, "src": TEST_SOURCE, "ref": r.id,
                },
            )  # fmt: skip
    yield
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM drugs WHERE source = :s"), {"s": TEST_SOURCE})
    await engine.dispose()


def _uuid_for(value: str) -> str:
    import uuid

    return str(uuid.uuid5(uuid.NAMESPACE_URL, value))


def _eval_module():
    import importlib.util

    sys.path.insert(0, str(ROOT / "data" / "scripts"))
    spec = importlib.util.spec_from_file_location(
        "run_matcher_eval", ROOT / "evals" / "run_matcher_eval.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
async def pg_service() -> AsyncIterator[CatalogService]:
    settings = load_settings(
        _env_file=None, NODE_ENV="test", LOG_LEVEL="silent", SERVICE_TOKEN="test-service-token",
        AI_DATABASE_URL=RO_URL,
    )  # fmt: skip
    database = Database(settings)
    yield CatalogService.from_settings(settings, database.session_factory)
    await database.dispose()


async def test_the_ai_role_can_read_the_catalog_and_aliases_but_not_write(
    seeded, pg_service
) -> None:
    rows = await pg_service.repo.all_rows()
    assert len([r for r in rows if r.source == TEST_SOURCE]) >= 100
    database = Database(
        load_settings(
            _env_file=None,
            NODE_ENV="test",
            LOG_LEVEL="silent",
            SERVICE_TOKEN="test-service-token",
            AI_DATABASE_URL=RO_URL,
        )
    )
    try:
        async with database.session_factory() as session:
            await session.execute(text("SELECT count(*) FROM salt_aliases"))
            with pytest.raises(Exception, match=r"read-only|permission denied"):
                await session.execute(text("UPDATE drugs SET brand_name = brand_name"))
    finally:
        await database.dispose()


async def test_postgres_and_memory_repositories_agree(seeded, pg_service) -> None:
    """Same exact / trigram / prefix / four-key answers (compared by brand name: ids differ)."""
    pg = pg_service.repo
    memory = InMemoryCatalogRepository(seed_rows())
    for key in ("dolo650", "dolo500", "pantop40", "zzzz", "telmaam"):
        assert sorted(
            r.brand_name for r in await pg.exact_brand(key) if r.source == TEST_SOURCE
        ) == sorted(r.brand_name for r in await memory.exact_brand(key)), key
    for key in ("pentop40", "dolo650mg", "augmentin", "atorva", "metformn500"):
        got = {
            (r.brand_name, round(s, 2))
            for r, s in await pg.trgm_brand(key, 0.45, 20)
            if r.source == TEST_SOURCE
        }
        want = {(r.brand_name, round(s, 2)) for r, s in await memory.trgm_brand(key, 0.45, 20)}
        assert got == want, key
    for prefix in ("dolo", "atorva", "gly"):
        assert sorted(
            r.brand_name for r in await pg.prefix_brand(prefix, 50) if r.source == TEST_SOURCE
        ) == sorted(r.brand_name for r in await memory.prefix_brand(prefix, 50))
    keys = ("paracetamol", "650mg", "tablet", "ir")
    assert sorted(
        r.brand_name for r in await pg.alternatives(*keys) if r.source == TEST_SOURCE
    ) == sorted(r.brand_name for r in await memory.alternatives(*keys))
    assert await pg.alternatives("paracetamol", "650mg", "tablet", "sr") == []


async def test_the_whole_matcher_eval_passes_against_the_real_database(
    seeded, pg_service, monkeypatch
) -> None:
    """The same 279 cases and the same hard gates, with pg_trgm and real rows instead of memory."""
    runner = _eval_module()
    cases = runner.load_cases()
    gates = dict.fromkeys(runner.GATES, 0)
    wrong = 0
    for case in cases:
        match = await pg_service.match(case["name"], case["strength"], case["form"])
        suggestion = await pg_service.generic(
            match, MedicineFacts(dose="1 tablet", frequency_per_day=2, duration_days=5)
        )
        alternatives = await pg_service.repo.by_ids([a.drug_id for a in suggestion.alternatives])
        alternatives = [a for a in alternatives if a.source == TEST_SOURCE]
        for violation in runner.violations(case, alternatives):
            gates[violation] += 1
        if case["gold"] is not None and match.salt_key and not match.ambiguous:
            got = {
                "salt_key": match.salt_key, "strength_key": match.strength_key,
                "form_key": match.form_key, "release_type": match.release_type,
            }  # fmt: skip
            wrong += got != case["gold"]
    assert gates == dict.fromkeys(runner.GATES, 0), gates
    assert wrong == 0


async def test_dolo_650_end_to_end_on_postgres(seeded, pg_service) -> None:
    match = await pg_service.match("डोलो 650", None, None)
    assert match.method.value == "exact" and match.salt_key == "paracetamol"
    suggestion = await pg_service.generic(
        match, MedicineFacts(dose="1 tablet", frequency_per_day=2, duration_days=5)
    )
    (alt,) = suggestion.alternatives
    assert alt.is_janaushadhi and alt.approx_savings == 15 and alt.price_per_unit == 1.5


async def test_an_unreachable_database_never_breaks_a_match() -> None:
    settings = load_settings(
        _env_file=None, NODE_ENV="test", LOG_LEVEL="silent", SERVICE_TOKEN="test-service-token",
        AI_DATABASE_URL="postgresql://u:p@127.0.0.1:1/none",
    )  # fmt: skip
    database = Database(settings)
    try:
        match = await asyncio.wait_for(
            CatalogService(PgCatalogRepository(database.session_factory)).match(
                "Dolo 650", None, None
            ),
            20,
        )
        assert match.note == "catalog_unavailable"
    finally:
        await database.dispose()
