"""Async, READ-ONLY database access for the AI service.

Why read-only is enforced in three layers (CLAUDE.md §4 — the gateway owns all user state):
  1. Only catalog read models exist (`app/db/models.py`).
  2. The service connects as the `dawai_ai_ro` role (SELECT on catalog tables only).
  3. Every connection sets `default_transaction_read_only = on`, so even a bug or a mis-configured
     (read/write) DATABASE_URL cannot write.
"""

import asyncio
from collections.abc import AsyncIterator
from typing import Final

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import Settings

CONNECT_TIMEOUT_S: Final = 2.0
COMMAND_TIMEOUT_S: Final = 10.0


class Database:
    """Owns the engine and session factory. Connects lazily, so the app boots without Postgres."""

    def __init__(self, settings: Settings) -> None:
        self.engine: AsyncEngine = create_async_engine(
            settings.database_url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=5,
            connect_args={
                "timeout": CONNECT_TIMEOUT_S,
                "command_timeout": COMMAND_TIMEOUT_S,
                "server_settings": {
                    "default_transaction_read_only": "on",
                    "application_name": "dawai-ai-service",
                },
            },
        )
        self.session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
            self.engine, expire_on_commit=False
        )

    async def ping(self) -> None:
        """Cheap round-trip for /health/ready. Raises if the DB is unreachable."""
        async with self.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def dispose(self) -> None:
        await self.engine.dispose()


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one read-only session per request."""
    database: Database = request.app.state.db
    async with database.session_factory() as session:
        yield session


async def check_database(database: Database, timeout_s: float = 2.0) -> bool:
    """True if the DB answers within `timeout_s`. Never raises (used by readiness)."""
    try:
        async with asyncio.timeout(timeout_s):
            await database.ping()
    except Exception:
        return False
    return True
