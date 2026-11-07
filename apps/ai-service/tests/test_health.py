import re

from fastapi import FastAPI
from httpx import AsyncClient

UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


async def test_live_returns_ok(client: AsyncClient) -> None:
    res = await client.get("/health/live")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


async def test_assigns_request_id(client: AsyncClient) -> None:
    res = await client.get("/health/live")
    assert UUID4.match(res.headers["x-request-id"])


async def test_propagates_safe_request_id(client: AsyncClient) -> None:
    res = await client.get("/health/live", headers={"x-request-id": "gw-abc.123"})
    assert res.headers["x-request-id"] == "gw-abc.123"


async def test_replaces_unsafe_request_id(client: AsyncClient) -> None:
    res = await client.get("/health/live", headers={"x-request-id": "bad id <script>"})
    assert UUID4.match(res.headers["x-request-id"])


async def test_unknown_route_uses_error_shape(client: AsyncClient) -> None:
    res = await client.get("/nope")
    assert res.status_code == 404
    assert res.json() == {
        "error": {
            "status": 404,
            "code": "NOT_FOUND",
            "message": "Not Found",
            "request_id": res.headers["x-request-id"],
        }
    }


async def test_unhandled_exception_returns_500_without_leaking(
    app: FastAPI, client: AsyncClient
) -> None:
    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("secret internal detail")

    res = await client.get("/boom")
    assert res.status_code == 500
    body = res.json()
    assert body["error"]["code"] == "INTERNAL_SERVER_ERROR"
    assert body["error"]["request_id"] == res.headers["x-request-id"]
    assert "secret" not in res.text
