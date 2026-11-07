"""Download a user's media from a presigned URL, safely (SSRF guard).

The gateway puts files in S3/MinIO and hands the AI service a presigned URL. A URL is
attacker-influenced data in principle, so before fetching anything we check:
  * the scheme is https (http is allowed only outside production, for local MinIO)
  * the host[:port] is on the `ALLOWED_MEDIA_HOSTS` allowlist
  * no credentials in the URL
  * redirects are NOT followed (a redirect could leave the allowlist)
  * the declared mime type is in the same allowlist as the gateway's media service
  * the size limit is enforced WHILE streaming, not only from Content-Length
The file lives in memory for the request only: never written to disk, never logged.

M5 builds and tests this; the prescription flow (M7) is its first user.
"""

from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from app.config import Settings
from app.llm.types import ImageInput

ALLOWED_MIME_TYPES = frozenset(
    {
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
        "audio/ogg",
        "audio/mpeg",
        "audio/mp4",
        "audio/aac",
    }
)
IMAGE_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
CHUNK_BYTES = 64 * 1024


class MediaRejectedError(Exception):
    """The media cannot be fetched or used. `code` is stable; the message never contains the URL."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class FetchedMedia:
    data: bytes
    mime: str

    def as_image(self) -> ImageInput:
        if self.mime not in IMAGE_MIME_TYPES:
            raise MediaRejectedError("not_an_image", "this media type is not an image")
        return ImageInput(data=self.data, mime=self.mime)


def normalise_mime(mime: str) -> str:
    return mime.split(";", 1)[0].strip().lower()


def validate_media_url(url: str, settings: Settings) -> None:
    """Raise MediaRejectedError unless the URL may be fetched. Never echoes the URL."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        raise MediaRejectedError("bad_url", "media url is not valid") from None

    if parts.scheme not in {"https", "http"}:
        raise MediaRejectedError("bad_scheme", "media url must use https")
    if parts.scheme == "http" and settings.environment == "production":
        raise MediaRejectedError("bad_scheme", "media url must use https")
    if parts.username or parts.password:
        raise MediaRejectedError("bad_url", "media url must not contain credentials")
    if not host:
        raise MediaRejectedError("bad_url", "media url has no host")

    authority = f"{host}:{port}" if port is not None else host
    allowed = settings.allowed_media_hosts
    if authority not in allowed and host not in allowed:
        raise MediaRejectedError("host_not_allowed", "media host is not allowed")


async def fetch_media(
    url: str,
    declared_mime: str,
    settings: Settings,
    *,
    client: httpx.AsyncClient | None = None,
    timeout_s: float = 15.0,
) -> FetchedMedia:
    """Fetch the media, enforcing the allowlist, mime type and size limit."""
    mime = normalise_mime(declared_mime)
    if mime not in ALLOWED_MIME_TYPES:
        raise MediaRejectedError("mime_not_allowed", "media type is not allowed")
    validate_media_url(url, settings)

    limit = settings.max_media_bytes
    owns_client = client is None
    http = client or httpx.AsyncClient(follow_redirects=False, timeout=timeout_s)
    try:
        async with http.stream("GET", url) as response:
            if response.is_redirect:
                raise MediaRejectedError("redirect", "media url redirected")
            if response.status_code != 200:
                raise MediaRejectedError(
                    "fetch_failed", f"media fetch failed ({response.status_code})"
                )

            announced = response.headers.get("content-length")
            if announced is not None and announced.isdigit() and int(announced) > limit:
                raise MediaRejectedError("too_large", "media is too large")

            received = bytearray()
            async for chunk in response.aiter_bytes(CHUNK_BYTES):
                received.extend(chunk)
                if len(received) > limit:
                    raise MediaRejectedError("too_large", "media is too large")
    except httpx.HTTPError:
        raise MediaRejectedError("fetch_failed", "media fetch failed") from None
    finally:
        if owns_client:
            await http.aclose()

    return FetchedMedia(data=bytes(received), mime=mime)
