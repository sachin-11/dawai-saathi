"""Request body size limit (pure ASGI, so it also works for chunked uploads with no Content-Length)."""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.observability.request_id import current_request_id
from app.schemas.errors import error_body

# /v1/process carries JSON with a text of at most 4000 characters and a URL: a few KB. Images are
# NOT uploaded here (the AI service fetches them from a presigned URL), so a small limit is safe.
MAX_BODY_BYTES = 64 * 1024


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = next(
            (value for name, value in scope.get("headers", []) if name == b"content-length"), None
        )
        if declared is not None and declared.isdigit() and int(declared) > self.max_bytes:
            await self._reject(send)
            return

        received = 0
        too_large = False

        async def limited_receive() -> Message:
            nonlocal received, too_large
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    too_large = True
                    # Stop feeding the app: it sees a disconnect and the response below wins.
                    return {"type": "http.disconnect"}
            return message

        responded = False

        async def guarded_send(message: Message) -> None:
            nonlocal responded
            if too_large and not responded:
                responded = True
                await self._reject(send)
                return
            if not too_large:
                await send(message)

        await self.app(scope, limited_receive, guarded_send)
        if too_large and not responded:
            await self._reject(send)

    @staticmethod
    async def _reject(send: Send) -> None:
        # The request-id middleware wraps this one, so the id is already bound.
        body = (
            error_body(413, "Request body too large", current_request_id())
            .model_dump_json()
            .encode()
        )
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
