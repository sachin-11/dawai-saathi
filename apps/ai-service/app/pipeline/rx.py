"""The prescription pipeline (M7, extended in M8). Since M9 the default is the LangGraph pipeline
(`app/graph`); this one stays behind `PIPELINE=minimal` as a rollback switch and is removed in M14.

  image / PDF
    -> load (fetch, PDF pages, prep, hopeless-photo check)        `app/tools/image_input.py`
    -> classify_image (cheap vision model): prescription | lab_report | medicine_strip | other
    -> vision_extract_rx (VISION_MODEL; one repair retry in the router)
    -> redact free text, validate, match the catalog, confidence gate
    -> compose_reply (LLM lines + grounding check, or the template) + disclaimer + buttons

Text and audio go to the inner pipeline unchanged (M5/M6). The emergency guard does NOT run here:
words written on a document are history, not a message from the user (CLAUDE.md §2.2).
"""

import asyncio

import structlog

from app.llm.types import ImageInput, LLMResult
from app.pipeline.base import Pipeline, PipelineContext, PipelineOutput
from app.schemas.process import (
    InputType,
    Intent,
    Language,
    ProcessRequest,
    Reply,
)
from app.tools.classify_image import IMAGE_CLASSIFY_PROMPT_ID, classify_image
from app.tools.image_input import load_images
from app.tools.rx_compose import (
    RX_COMPOSE_PROMPT_ID,
    RX_TEMPLATE_VERSION,
    build_reply,
    compose_text,
)
from app.tools.rx_enrich import (
    NEEDS_REVIEW_WARNING,
    enrich_with_catalog,
    needs_review_extraction,
    redact_free_text,
)
from app.tools.rx_gate import apply_gate
from app.tools.rx_validate import validate_extraction
from app.tools.vision_extract_rx import RX_EXTRACT_PROMPT_ID, extract_prescription

log = structlog.get_logger("rx_pipeline")


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

        loaded = await load_images(request, ctx.settings)
        if loaded.template_key is not None:
            return _static(ctx, language, loaded.template_key, Intent.other)

        images = loaded.images
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
        extraction = await asyncio.to_thread(redact_free_text, extraction, ctx.redactor)
        validated = validate_extraction(extraction, threshold)
        validated = await enrich_with_catalog(validated, ctx.catalog, threshold)
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
    return PipelineOutput(
        intent=Intent.prescription,
        emergency=False,
        reply=Reply(language=language, text=ctx.templates.get(language, "rx.needs_review")),
        warnings=[NEEDS_REVIEW_WARNING],
        extraction=needs_review_extraction(),
    )
