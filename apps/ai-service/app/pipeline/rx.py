"""The prescription pipeline (M7). Replaced by the LangGraph graph in M9 behind the same interface.

  image / PDF
    -> fetch (SSRF-safe)                      -> PDF: render the first pages
    -> prep (orientation, RGB, downscale, EXIF stripped, quality signals)
    -> hopeless quality?   yes: ask for a better photo, NO model call
    -> classify_image (cheap vision model): prescription | lab_report | medicine_strip | other
    -> vision_extract_rx (VISION_MODEL; one repair retry in the router)
    -> redact free text, validate_and_normalise (deterministic), confidence_gate
    -> compose_reply (LLM lines + grounding check, or the template) + disclaimer + buttons

Text and audio go to the inner pipeline unchanged (M5/M6). The emergency guard does NOT run here:
words written on a document are history, not a message from the user (CLAUDE.md §2.2).
"""

import asyncio
from collections.abc import Callable
from typing import Final

import structlog

from app.api.errors import ApiError
from app.llm.types import ImageInput, LLMResult
from app.media.fetcher import IMAGE_MIME_TYPES, FetchedMedia, MediaRejectedError, fetch_media
from app.pipeline.base import Pipeline, PipelineContext, PipelineOutput
from app.schemas.prescription import DateField, PrescriptionExtraction, TextField
from app.schemas.process import (
    InputType,
    Intent,
    Language,
    ProcessRequest,
    Reply,
    Warning,
    WarningType,
)
from app.tools.classify_image import IMAGE_CLASSIFY_PROMPT_ID, classify_image
from app.tools.image_prep import ImagePrepError, PreparedImage, prepare_image, prepare_pil
from app.tools.pdf_render import PdfRejectedError, render_pdf_pages
from app.tools.rx_compose import (
    RX_COMPOSE_PROMPT_ID,
    RX_TEMPLATE_VERSION,
    build_reply,
    compose_text,
)
from app.tools.rx_gate import apply_gate
from app.tools.rx_validate import validate_extraction
from app.tools.vision_extract_rx import RX_EXTRACT_PROMPT_ID, extract_prescription

log = structlog.get_logger("rx_pipeline")

# Fetch failures that are the user's file (not our infrastructure): answer politely, do not retry.
_USER_FILE_CODES: Final = frozenset({"too_large", "mime_not_allowed", "not_an_image"})


class RxPipeline:
    """Handles `image` input; everything else goes to `inner`."""

    def __init__(self, inner: Pipeline) -> None:
        self._inner = inner

    async def run(self, request: ProcessRequest, ctx: PipelineContext) -> PipelineOutput:
        if request.input.type is not InputType.image:
            return await self._inner.run(request, ctx)
        return await self._run_image(request, ctx)

    # ------------------------------------------------------------------ flow

    async def _run_image(self, request: ProcessRequest, ctx: PipelineContext) -> PipelineOutput:
        language = request.user.language
        ctx.usage.add_prompt_version(ctx.templates.version)

        media = await self._fetch(request, ctx)
        if isinstance(media, PipelineOutput):
            return media

        prepared = await self._prepare(media, ctx, language)
        if isinstance(prepared, PipelineOutput):
            return prepared

        # Hopeless photo: do not pay for a vision call (CLAUDE.md M7 §3). Every page must be hopeless.
        if all(page.quality.unreadable for page in prepared):
            hint = prepared[0].quality.hint()
            log.info("image_quality_rejected", hint=hint, pages=len(prepared))
            return _static(ctx, language, f"rx.resend_{hint}", Intent.other)

        images = [page.image for page in prepared]
        classification, result = await classify_image(
            images, router=ctx.router, prompts=ctx.prompts, deadline=ctx.deadline
        )
        _track(ctx, result, IMAGE_CLASSIFY_PROMPT_ID)
        if classification.kind == "lab_report":
            return _static(ctx, language, "rx.lab_report", Intent.lab_report)
        if classification.kind == "medicine_strip":
            return _static(ctx, language, "rx.medicine_strip", Intent.other)
        if classification.kind == "other":
            return _static(ctx, language, "rx.other", Intent.other)
        if classification.quality == "unreadable":
            return _static(ctx, language, "rx.unreadable", Intent.other)

        return await self._read_prescription(images, ctx, language)

    async def _read_prescription(
        self, images: list[ImageInput], ctx: PipelineContext, language: Language
    ) -> PipelineOutput:
        extraction, result = await extract_prescription(
            images, router=ctx.router, prompts=ctx.prompts, deadline=ctx.deadline
        )
        _track(ctx, result, RX_EXTRACT_PROMPT_ID)
        if extraction is None:
            # Structure still invalid after the repair: say so, never guess (CLAUDE.md §2.3).
            log.warning("rx_extraction_schema_failed")
            return _needs_review(ctx, language)

        threshold = ctx.settings.extraction_min_confidence
        extraction = await asyncio.to_thread(_redact_free_text, extraction, ctx)
        validated = validate_extraction(extraction, threshold)
        gate = apply_gate(validated, threshold)
        gated = gate.extraction

        if gate.failure == "not_a_prescription":
            return _static(ctx, language, "rx.other", Intent.other)
        if gate.failure is not None:
            # Unreadable / nothing readable: keep the (PHI-free) extraction so the gateway records a
            # failed document, but show no medicine list and ask for a better photo.
            return PipelineOutput(
                intent=Intent.prescription,
                emergency=False,
                reply=Reply(language=language, text=ctx.templates.get(language, "rx.unreadable")),
                warnings=gate.warnings,
                extraction=gated,
            )

        outcome = await compose_text(
            gated,
            language,
            min_confidence=threshold,
            router=ctx.router,
            prompts=ctx.prompts,
            deadline=ctx.deadline,
        )
        _track(ctx, outcome.llm_result, RX_COMPOSE_PROMPT_ID)
        ctx.usage.add_prompt_version(RX_TEMPLATE_VERSION)
        return PipelineOutput(
            intent=Intent.prescription,
            emergency=False,
            reply=build_reply(outcome.text, language, with_buttons=True),
            warnings=gate.warnings,
            extraction=gated,
        )

    # ------------------------------------------------------------------ input handling

    async def _fetch(
        self, request: ProcessRequest, ctx: PipelineContext
    ) -> FetchedMedia | PipelineOutput:
        language = request.user.language
        assert request.input.media_url is not None and request.input.mime is not None  # noqa: S101
        try:
            return await fetch_media(request.input.media_url, request.input.mime, ctx.settings)
        except MediaRejectedError as error:
            if error.code in _USER_FILE_CODES:
                return _static(ctx, language, "rx.bad_file", Intent.other)
            # Our side (URL expired, host not allowed, S3 down): the gateway retries.
            log.warning("media_fetch_failed", code=error.code)
            raise ApiError(
                502, "MEDIA_FETCH_FAILED", "The uploaded file could not be fetched"
            ) from None

    async def _prepare(
        self, media: FetchedMedia, ctx: PipelineContext, language: Language
    ) -> list[PreparedImage] | PipelineOutput:
        max_px = ctx.settings.vision_max_px
        sharpness = ctx.settings.image_min_sharpness

        def work() -> list[PreparedImage]:
            if media.mime == "application/pdf":
                pages = render_pdf_pages(media.data, max_px=max_px)
                return [prepare_pil(p, max_px=max_px, min_sharpness=sharpness) for p in pages]
            if media.mime not in IMAGE_MIME_TYPES:
                raise ImagePrepError("not_an_image", "not an image")
            return [prepare_image(media.data, max_px=max_px, min_sharpness=sharpness)]

        try:
            return await asyncio.to_thread(work)
        except PdfRejectedError as error:
            key = {
                "encrypted_pdf": "rx.pdf_encrypted",
                "too_many_pages": "rx.pdf_too_long",
            }.get(error.code, "rx.bad_file")
            log.info("pdf_rejected", code=error.code)
            return _static(ctx, language, key, Intent.other)
        except ImagePrepError as error:
            log.info("image_rejected", code=error.code)
            return _static(ctx, language, "rx.bad_file", Intent.other)


# ---------------------------------------------------------------------- helpers


def _track(ctx: PipelineContext, result: LLMResult | None, prompt_version: str) -> None:
    """Add a call's cost and latency to the request, and always record the prompt version used
    (also when the call failed: `documents.prompt_version` must say what was attempted)."""
    ctx.usage.add_prompt_version(prompt_version)
    if result is not None:
        ctx.usage.add(result, prompt_version)


def _static(ctx: PipelineContext, language: Language, key: str, intent: Intent) -> PipelineOutput:
    return PipelineOutput(
        intent=intent,
        emergency=False,
        reply=Reply(language=language, text=ctx.templates.get(language, key)),
    )


def _needs_review(ctx: PipelineContext, language: Language) -> PipelineOutput:
    extraction = PrescriptionExtraction(
        is_prescription=True,
        image_quality="poor",
        medicines=[],
        prescription_date=DateField(value=None, confidence=0.0),
        overall_confidence=0.0,
        status="needs_review",
    )
    return PipelineOutput(
        intent=Intent.prescription,
        emergency=False,
        reply=Reply(language=language, text=ctx.templates.get(language, "rx.needs_review")),
        warnings=[
            Warning(type=WarningType.low_confidence, detail="prescription could not be read")
        ],
        extraction=extraction,
    )


def _redact_free_text(
    extraction: PrescriptionExtraction, ctx: PipelineContext
) -> PrescriptionExtraction:
    """PHI minimisation, second line: the schema has no PHI fields, and the few free-text fields
    (the written line, instructions, notes) still go through the redactor before anything is stored."""
    redact: Callable[[str], str] = lambda text: ctx.redactor.redact(text).text  # noqa: E731
    medicines = []
    for medicine in extraction.medicines:
        updated = medicine.model_copy(deep=True)
        if updated.raw_text.value:
            updated.raw_text = TextField(
                value=redact(updated.raw_text.value), confidence=updated.raw_text.confidence
            )
        if updated.instructions.value:
            updated.instructions = TextField(
                value=redact(updated.instructions.value), confidence=updated.instructions.confidence
            )
        medicines.append(updated)
    notes = [redact(note) for note in extraction.notes_for_user]
    return extraction.model_copy(update={"medicines": medicines, "notes_for_user": notes})
