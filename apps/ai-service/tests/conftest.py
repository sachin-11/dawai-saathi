from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.config import Settings, load_settings
from app.main import create_app

_ENV_KEYS = (
    "APP_ENV",
    "NODE_ENV",
    "LOG_LEVEL",
    "SERVICE_TOKEN",
    "AI_DATABASE_URL",
    "DATABASE_URL",
    "LLM_MODE",
    "LLM_PRIMARY",
    "LLM_FALLBACK",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "VISION_MODEL",
    "TEXT_MODEL",
    "CHEAP_MODEL",
    "FALLBACK_VISION_MODEL",
    "FALLBACK_TEXT_MODEL",
    "FALLBACK_CHEAP_MODEL",
    "PROCESS_TIMEOUT_S",
    "ALLOWED_MEDIA_HOSTS",
    "MAX_MEDIA_MB",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_HOST",
    "EMERGENCY_MIN_CONFIDENCE",
    "EMERGENCY_CLASSIFIER_TIMEOUT_S",
    "REDACTION_ENABLED",
)

# Nothing listens here: unit tests must never need (or accidentally reach) a real database.
UNREACHABLE_DB_URL = "postgresql://user:pass@127.0.0.1:1/none"
SERVICE_TOKEN = "test-service-token"


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests must not depend on the developer's shell or .env file."""
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def make_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "_env_file": None,
        "NODE_ENV": "test",
        "LOG_LEVEL": "silent",
        "SERVICE_TOKEN": SERVICE_TOKEN,
        "DATABASE_URL": UNREACHABLE_DB_URL,
        "LLM_MODE": "fake",
    }
    values.update(overrides)
    return load_settings(**values)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
