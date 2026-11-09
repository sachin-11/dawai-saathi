"""Load the user's file for the prescription flow (moved out of `pipeline/rx.py` in M9).

fetch (SSRF-safe presigned URL) -> PDF: render the first pages -> prep (orientation, RGB, resize,
EXIF stripped, quality signals) -> a hopeless photo is refused BEFORE any model call.

The result is either usable images or the key of a static reply that tells the user what to do. A
failure on OUR side (the file cannot be fetched) still raises, so the gateway retries.
"""

import asyncio
from dataclasses import dataclass
from typing import Final

import structlog

from app.api.errors import ApiError
from app.config import Settings
from app.llm.types import ImageInput
from app.media.fetcher import IMAGE_MIME_TYPES, FetchedMedia, MediaRejectedError, fetch_media
from app.schemas.process import ProcessRequest
from app.tools.image_prep import ImagePrepError, PreparedImage, prepare_image, prepare_pil
from app.tools.pdf_render import PdfRejectedError, render_pdf_pages

log = structlog.get_logger("image_input")

# Fetch failures that are the user's file (not our infrastructure): answer politely, do not retry.
_USER_FILE_CODES: Final = frozenset({"too_large", "mime_not_allowed", "not_an_image"})


@dataclass(frozen=True, slots=True)
class LoadedImages:
    images: list[ImageInput]
    template_key: str | None = None  # set when the file cannot be used: key of a static reply


async def load_images(request: ProcessRequest, settings: Settings) -> LoadedImages:
    assert request.input.media_url is not None and request.input.mime is not None  # noqa: S101
    try:
        media = await fetch_media(request.input.media_url, request.input.mime, settings)
    except MediaRejectedError as error:
        if error.code in _USER_FILE_CODES:
            return LoadedImages([], "rx.bad_file")
        # Our side (URL expired, host not allowed, S3 down): the gateway retries.
        log.warning("media_fetch_failed", code=error.code)
        raise ApiError(
            502, "MEDIA_FETCH_FAILED", "The uploaded file could not be fetched"
        ) from None

    pages = await _prepare(media, settings)
    if isinstance(pages, str):
        return LoadedImages([], pages)

    # Hopeless photo: do not pay for a vision call (CLAUDE.md M7 §3). Every page must be hopeless.
    if all(page.quality.unreadable for page in pages):
        hint = pages[0].quality.hint()
        log.info("image_quality_rejected", hint=hint, pages=len(pages))
        return LoadedImages([], f"rx.resend_{hint}")
    return LoadedImages([page.image for page in pages])


async def _prepare(media: FetchedMedia, settings: Settings) -> list[PreparedImage] | str:
    max_px = settings.vision_max_px
    sharpness = settings.image_min_sharpness

    def work() -> list[PreparedImage]:
        if media.mime == "application/pdf":
            pages = render_pdf_pages(media.data, max_px=max_px, pages=settings.lab_max_pages)
            return [prepare_pil(p, max_px=max_px, min_sharpness=sharpness) for p in pages]
        if media.mime not in IMAGE_MIME_TYPES:
            raise ImagePrepError("not_an_image", "not an image")
        return [prepare_image(media.data, max_px=max_px, min_sharpness=sharpness)]

    try:
        return await asyncio.to_thread(work)
    except PdfRejectedError as error:
        log.info("pdf_rejected", code=error.code)
        return {"encrypted_pdf": "rx.pdf_encrypted", "too_many_pages": "rx.pdf_too_long"}.get(
            error.code, "rx.bad_file"
        )
    except ImagePrepError as error:
        log.info("image_rejected", code=error.code)
        return "rx.bad_file"
