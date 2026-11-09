"""The lab catalog as the pipeline uses it (M12): one cached `LabIndex`, never raises."""

import time

import structlog
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.labs.catalog import LabRepository, PgLabRepository
from app.tools.lab_normalize import LabIndex

log = structlog.get_logger("lab_service")

_TTL_S = 600.0


class LabService:
    def __init__(self, repo: LabRepository, ttl_s: float = _TTL_S) -> None:
        self.repo = repo
        self._ttl = ttl_s
        self._index: LabIndex | None = None
        self._loaded_at = 0.0

    @classmethod
    def from_sessions(cls, sessions: async_sessionmaker[AsyncSession]) -> "LabService":
        return cls(PgLabRepository(sessions))

    async def index(self) -> LabIndex | None:
        """The test index, cached for a few minutes. After a database problem the last good copy is
        kept; with none at all the result is None ("the lab reference is unavailable", never "normal")."""
        if self._index is None or time.monotonic() - self._loaded_at > self._ttl:
            try:
                tests = await self.repo.all_tests()
                if tests:
                    self._index = LabIndex(tests)
                    self._loaded_at = time.monotonic()
            except Exception as error:
                log.warning("lab_catalog_failed", error_type=type(error).__name__)
        return self._index
