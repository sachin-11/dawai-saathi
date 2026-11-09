import asyncio

import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from app.db.session import check_database


class _StubDatabase:
    """Stands in for `Database`; each test decides how `ping` behaves."""

    def __init__(self, behaviour: str) -> None:
        self.behaviour = behaviour

    async def ping(self) -> None:
        if self.behaviour == "fail":
            raise ConnectionRefusedError("postgresql://user:s3cr3t@db/dawai refused")
        if self.behaviour == "hang":
            await asyncio.sleep(60)

    async def dispose(self) -> None:
        return None


async def test_ready_returns_200_when_db_answers(app: FastAPI, client: AsyncClient) -> None:
    app.state.db = _StubDatabase("ok")
    res = await client.get("/health/ready")
    assert res.status_code == 200
    assert res.json() == {
        "status": "ok",
        "checks": {"db": "ok", "llm_config": "ok", "llm_circuits": "closed"},
    }


async def test_ready_returns_503_when_db_fails(app: FastAPI, client: AsyncClient) -> None:
    app.state.db = _StubDatabase("fail")
    res = await client.get("/health/ready")
    assert res.status_code == 503
    assert res.json() == {
        "status": "degraded",
        "checks": {"db": "fail", "llm_config": "ok", "llm_circuits": "closed"},
    }


async def test_ready_does_not_leak_the_underlying_error(app: FastAPI, client: AsyncClient) -> None:
    app.state.db = _StubDatabase("fail")
    res = await client.get("/health/ready")
    assert "s3cr3t" not in res.text


async def test_ready_returns_503_against_an_unreachable_real_engine(client: AsyncClient) -> None:
    # No stub: the real engine points at 127.0.0.1:1, so the check must fail fast, not hang.
    res = await client.get("/health/ready")
    assert res.status_code == 503
    assert res.json()["checks"] == {"db": "fail", "llm_config": "ok", "llm_circuits": "closed"}


async def test_live_ignores_dependencies(app: FastAPI, client: AsyncClient) -> None:
    app.state.db = _StubDatabase("fail")
    res = await client.get("/health/live")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


async def test_check_database_times_out_instead_of_hanging() -> None:
    assert await check_database(_StubDatabase("hang"), timeout_s=0.05) is False  # type: ignore[arg-type]


@pytest.mark.parametrize(("behaviour", "expected"), [("ok", True), ("fail", False)])
async def test_check_database_never_raises(behaviour: str, expected: bool) -> None:
    assert await check_database(_StubDatabase(behaviour)) is expected  # type: ignore[arg-type]
