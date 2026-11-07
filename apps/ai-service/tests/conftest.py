from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.config import Settings, load_settings
from app.main import create_app

_ENV_KEYS = ("APP_ENV", "NODE_ENV", "LOG_LEVEL", "SERVICE_TOKEN", "AI_DATABASE_URL", "DATABASE_URL")

# Nothing listens here: unit tests must never need (or accidentally reach) a real database.
UNREACHABLE_DB_URL = "postgresql://user:pass@127.0.0.1:1/none"


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests must not depend on the developer's shell or .env file."""
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def settings() -> Settings:
    return load_settings(
        _env_file=None,
        NODE_ENV="test",
        LOG_LEVEL="silent",
        SERVICE_TOKEN="test-service-token",
        DATABASE_URL=UNREACHABLE_DB_URL,
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
