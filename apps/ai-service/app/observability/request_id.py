"""Pure-ASGI middleware: request_id per request + one structured access log line.

- Reuses a safe inbound `x-request-id` (e.g. from the gateway) or mints a UUID4.
- Binds `request_id` into structlog contextvars so every log line carries it.
- Echoes the id on the response.
- Logs method, path (no query string — may contain tokens/PHI), status, duration.
- Turns any unhandled exception into a 500 with the standard error body.
"""

import re
import time
import uuid
from typing import Final

import structlog
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.schemas.errors import error_body

REQUEST_ID_HEADER: Final = "x-request-id"
_SAFE_REQUEST_ID: Final = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

log = structlog.get_logger("http")


def resolve_request_id(scope: Scope) -> str:
    for name, value in scope.get("headers", []):
        if name.decode("latin-1").lower() == REQUEST_ID_HEADER:
            candidate: str = value.decode("latin-1")
            if _SAFE_REQUEST_ID.fullmatch(candidate):
                return candidate
            break
    return str(uuid.uuid4())


def current_request_id() -> str:
    value = structlog.contextvars.get_contextvars().get("request_id", "")
    return value if isinstance(value, str) else ""


class RequestIdMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = resolve_request_id(scope)
        started = time.perf_counter()
        status_code = 500
        response_started = False

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status_code = message["status"]
                headers = list(message.get("headers", []))
                headers.append((REQUEST_ID_HEADER.encode(), request_id.encode()))
                message["headers"] = headers
            await send(message)

        with structlog.contextvars.bound_contextvars(request_id=request_id):
            try:
                await self.app(scope, receive, send_wrapper)
            except Exception:
                log.exception("unhandled error")
                if not response_started:
                    await _send_internal_error(send_wrapper, request_id)
            finally:
                log.info(
                    "request completed",
                    method=scope.get("method"),
                    path=scope.get("path"),
                    status=status_code,
                    duration_ms=round((time.perf_counter() - started) * 1000, 2),
                )


async def _send_internal_error(send: Send, request_id: str) -> None:
    body = error_body(500, "Internal server error", request_id).model_dump_json().encode()
    await send(
        {
            "type": "http.response.start",
            "status": 500,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
