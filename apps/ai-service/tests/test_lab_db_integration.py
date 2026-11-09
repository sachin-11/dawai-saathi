"""The Postgres lab repository against a REAL database (docker-compose.test.yml), M12.

    make test-integration                    # starts the stack, runs everything, cleans up
    uv run pytest -m integration             # with the stack running and migrated

Runs the REAL seed script (`data/scripts/seed_lab_tests.py`) as the admin role, twice (it must be
idempotent), reads the table back as the READ-ONLY service role and checks that `PgLabRepository`
returns exactly what the in-memory repository (unit tests, eval) holds, that a report gives the same
reply on top of it, and that the AI role cannot write.
"""

import importlib.util
import os
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import load_settings
from app.db.session import Database
from app.labs.catalog import InMemoryLabRepository, PgLabRepository
from app.labs.service import LabService
from app.llm.fake import FakeProvider
from tests.graph_support import run_graph
from tests.lab_support import CLASSIFY_LAB, lab_image_request, report, row
from tests.rx_support import fake_fetch, sample_jpeg

pytestmark = pytest.mark.integration

RO_URL = os.environ.get(
    "INTEGRATION_AI_DATABASE_URL", "postgresql://dawai_ai_ro:dawai_ai_ro@localhost:5543/dawai_test"
)
ADMIN_URL = os.environ.get(
    "INTEGRATION_DATABASE_URL", "postgresql://dawai:dawai@localhost:5543/dawai_test"
)
ROOT = Path(__file__).parents[3]


def _asyncpg(url: str) -> str:
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


def _seed_module():
    spec = importlib.util.spec_from_file_location(
        "seed_lab_tests", ROOT / "data" / "scripts" / "seed_lab_tests.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
async def seeded(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[int]:
    assert ADMIN_URL.rsplit("/", 1)[-1].endswith("_test"), (
        "refusing to run outside a *_test database"
    )
    monkeypatch.setenv("DATABASE_URL", ADMIN_URL)
    module = _seed_module()
    tests = module.build_lab_tests(module.load_seed())
    assert module.problems(tests) == []
    await module.load_into_db(tests)
    await module.load_into_db(tests)  # idempotent: the second run changes nothing
    engine = create_async_engine(_asyncpg(ADMIN_URL))
    async with engine.connect() as conn:
        rows = (await conn.execute(text("SELECT count(*) FROM lab_tests"))).scalar_one()
    await engine.dispose()
    yield int(rows)


@pytest.fixture
async def database() -> AsyncIterator[Database]:
    settings = load_settings(
        _env_file=None, NODE_ENV="test", LOG_LEVEL="silent", SERVICE_TOKEN="test-service-token",
        AI_DATABASE_URL=RO_URL,
    )  # fmt: skip
    db = Database(settings)
    yield db
    await db.dispose()


async def test_the_seed_is_idempotent_and_complete(seeded: int):
    memory = await InMemoryLabRepository().all_tests()
    assert seeded == sum(len(t.ranges) or 1 for t in memory)


async def test_postgres_and_memory_repositories_hold_the_same_tests(
    seeded: int, database: Database
):
    pg = {t.code: t for t in await PgLabRepository(database.session_factory).all_tests()}
    memory = {t.code: t for t in await InMemoryLabRepository().all_tests()}
    assert pg.keys() == memory.keys()
    for code, expected in memory.items():
        got = pg[code]
        assert got.name == expected.name and got.unit == expected.unit, code
        assert got.section == expected.section and got.source == expected.source, code
        assert set(got.aliases) == set(expected.aliases), code
        assert dict(got.conversions) == dict(expected.conversions), code
        assert {(r.sex, r.age_min, r.age_max, r.low, r.high) for r in got.ranges} == {
            (r.sex, r.age_min, r.age_max, r.low, r.high) for r in expected.ranges
        }, code
        assert set(got.qualitative_normal) == set(expected.qualitative_normal), code
        assert (got.critical_low, got.critical_high) == (
            expected.critical_low,
            expected.critical_high,
        ), code
        assert got.explanation_en == expected.explanation_en and not got.hi_reviewed, code
        assert list(got.questions_en) == list(expected.questions_en), code


async def test_a_report_gets_the_same_reply_on_postgres_and_in_memory(
    seeded: int, database: Database, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
    )
    rows = (
        row("Haemoglobin", "6.1", "g/dL", 12.0, 15.5, "12.0 - 15.5", "L", "CBC"),
        row("Platelet Count", "2.5", "lakhs/cumm", 1.5, 4.5, "1.5 - 4.5", None, "CBC"),
        row("TSH", "6.2", "µIU/mL", 0.4, 4.2, "0.4 - 4.2", "H", "Thyroid"),
    )
    texts = []
    for service in (
        LabService(PgLabRepository(database.session_factory)),
        LabService(InMemoryLabRepository()),
    ):
        provider = FakeProvider([CLASSIFY_LAB, report(*rows)])
        output, _ = await run_graph(provider, lab_image_request(), labs=service)
        texts.append(output.reply.text)
    assert texts[0] == texts[1]
    assert texts[0].startswith("🚨")


async def test_the_ai_role_cannot_write(seeded: int, database: Database):
    async with database.session_factory() as session:
        with pytest.raises(DBAPIError):
            await session.execute(text("DELETE FROM lab_tests"))
            await session.commit()
        await session.rollback()
        with pytest.raises(DBAPIError):
            await session.execute(text("SELECT count(*) FROM lab_results"))  # no grant at all
        await session.rollback()


def test_the_seed_script_check_mode_needs_no_database():
    module = _seed_module()
    tests = module.build_lab_tests(module.load_seed())
    assert len(tests) >= 60
