"""Integration tests against a REAL Postgres (the docker-compose.test.yml stack).

    make test-integration                      # starts the stack, runs gateway + this, cleans up
    uv run pytest -m integration               # with the stack already running and migrated

The gateway owns the schema, so migrations must already be applied (the gateway integration test or
`prisma migrate deploy` does that). Refuses to run unless the DB name ends with "_test".
"""

import os
import uuid
from collections.abc import AsyncIterator
from decimal import Decimal

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import Settings, load_settings
from app.db.models import Drug, Interaction, InteractionSeverity, LabSex, LabTest
from app.db.session import Database
from app.main import create_app

pytestmark = pytest.mark.integration

RO_URL = os.environ.get(
    "INTEGRATION_AI_DATABASE_URL", "postgresql://dawai_ai_ro:dawai_ai_ro@localhost:5543/dawai_test"
)
ADMIN_URL = os.environ.get(
    "INTEGRATION_DATABASE_URL", "postgresql://dawai:dawai@localhost:5543/dawai_test"
)


def _as_asyncpg(url: str) -> str:
    return url.replace("postgresql://", "postgresql+asyncpg://", 1)


@pytest.fixture(scope="module")
def ro_settings() -> Settings:
    settings = load_settings(
        _env_file=None,
        NODE_ENV="test",
        LOG_LEVEL="silent",
        SERVICE_TOKEN="test-service-token",
        AI_DATABASE_URL=RO_URL,
    )
    db_name = settings.database_url.rsplit("/", 1)[-1]
    if not db_name.endswith("_test"):
        pytest.fail(f'Refusing to run against database "{db_name}" (must end with _test)')
    return settings


@pytest.fixture
async def database(ro_settings: Settings) -> AsyncIterator[Database]:
    db = Database(ro_settings)
    yield db
    await db.dispose()


@pytest.fixture
async def admin_engine() -> AsyncIterator[AsyncEngine]:
    """Read/write connection used ONLY to seed rows the read-only service then reads."""
    engine = create_async_engine(_as_asyncpg(ADMIN_URL))
    yield engine
    await engine.dispose()


async def test_ping_succeeds(database: Database) -> None:
    await database.ping()


async def test_can_query_drugs_table(database: Database) -> None:
    async with database.session_factory() as session:
        rows = (await session.execute(select(Drug).limit(5))).scalars().all()
    assert isinstance(rows, list)  # empty is fine


async def test_read_models_match_the_real_schema(
    database: Database, admin_engine: AsyncEngine
) -> None:
    """Seed one row per catalog table as admin; read back through the ORM models as the RO role."""
    tag = uuid.uuid4().hex[:8]
    async with admin_engine.begin() as conn:
        drug_id = (
            await conn.execute(
                text(
                    "INSERT INTO drugs (brand_name, salt_composition, strength, form, mrp, is_generic, source) "
                    "VALUES (:b, 'paracetamol', '650 mg', 'tablet', 30.50, false, 'it') RETURNING id"
                ),
                {"b": f"Dolo-{tag}"},
            )
        ).scalar_one()
        await conn.execute(
            text(
                "INSERT INTO interactions (salt_a, salt_b, severity, summary, source) "
                "VALUES (:a, :b, 'major', 'test', 'it')"
            ),
            {"a": f"aspirin-{tag}", "b": f"warfarin-{tag}"},
        )
        await conn.execute(
            text(
                "INSERT INTO lab_tests (code, name, aliases, unit, ref_low, ref_high, sex, "
                "explanation_en, explanation_hi, source) "
                "VALUES (:c, 'Hemoglobin', ARRAY['Hb', 'Hgb'], 'g/dL', 13.0, 17.0, 'm', 'en', 'hi', 'it')"
            ),
            {"c": f"HB-{tag}"},
        )
    try:
        async with database.session_factory() as session:
            drug = (await session.execute(select(Drug).where(Drug.id == drug_id))).scalar_one()
            interaction = (
                await session.execute(
                    select(Interaction).where(Interaction.salt_a == f"aspirin-{tag}")
                )
            ).scalar_one()
            lab = (
                await session.execute(select(LabTest).where(LabTest.code == f"HB-{tag}"))
            ).scalar_one()
        assert drug.brand_name == f"Dolo-{tag}"
        assert drug.mrp == Decimal("30.50")
        assert drug.is_generic is False
        assert interaction.severity is InteractionSeverity.major
        assert lab.sex is LabSex.m
        assert lab.aliases == ["Hb", "Hgb"]
        assert lab.ref_high == Decimal("17.0")
    finally:
        async with admin_engine.begin() as conn:
            await conn.execute(
                text("DELETE FROM drugs WHERE brand_name = :b"), {"b": f"Dolo-{tag}"}
            )
            await conn.execute(
                text("DELETE FROM interactions WHERE salt_a = :a"), {"a": f"aspirin-{tag}"}
            )
            await conn.execute(text("DELETE FROM lab_tests WHERE code = :c"), {"c": f"HB-{tag}"})


async def test_service_cannot_write_catalog_tables(database: Database) -> None:
    async with database.session_factory() as session:
        with pytest.raises(DBAPIError):
            await session.execute(
                text(
                    "INSERT INTO drugs (brand_name, salt_composition, strength, form, source) "
                    "VALUES ('x', 'x', 'x', 'x', 'x')"
                )
            )


async def test_service_cannot_read_user_data(database: Database) -> None:
    """Ownership rule (CLAUDE.md §4): user tables are invisible to the AI service's DB role."""
    async with database.session_factory() as session:
        for table in ("users", "messages", "documents", "medications", "reminders", "caregivers"):
            with pytest.raises(DBAPIError, match="permission denied"):
                await session.execute(text(f"SELECT 1 FROM {table} LIMIT 1"))
            await session.rollback()


async def test_sessions_are_read_only_even_with_a_write_capable_role(
    ro_settings: Settings,
) -> None:
    """Defence in depth: connecting as the admin role is still read-only at the session level."""
    admin_settings = load_settings(
        _env_file=None,
        NODE_ENV="test",
        LOG_LEVEL="silent",
        SERVICE_TOKEN="test-service-token",
        AI_DATABASE_URL=ADMIN_URL,
    )
    db = Database(admin_settings)
    try:
        async with db.session_factory() as session:
            with pytest.raises(DBAPIError, match="read-only transaction"):
                await session.execute(
                    text(
                        "INSERT INTO drugs (brand_name, salt_composition, strength, form, source) "
                        "VALUES ('x', 'x', 'x', 'x', 'x')"
                    )
                )
    finally:
        await db.dispose()


async def test_ready_endpoint_returns_200(ro_settings: Settings) -> None:
    app = create_app(ro_settings)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health/ready")
        assert res.status_code == 200
        assert res.json() == {"status": "ok", "checks": {"db": "ok"}}
    await app.state.db.dispose()
