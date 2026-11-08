"""The minimal pipeline (M5, extended in M6/M8). Since M9 the default is the LangGraph pipeline
(`app/graph`); this one stays behind `PIPELINE=minimal` as a rollback switch and is removed in M14.

  text  -> 1. emergency rules on the user's RAW text (fast; a match answers at once, nothing else runs)
           2. redact (phone, Aadhaar-like, e-mail, names ...)
           3. emergency classifier on the REDACTED text (fails safe)
           4. intent classifier (CHEAP model, structured output) on the REDACTED text
           5. a STATIC template: help / greeting / out_of_scope / "coming soon"
  image / audio -> no LLM call yet; a static "received, coming soon" text. The emergency guard does
                   not run on them: text extracted from a document is history, not a message from
                   the user (CLAUDE.md §2.2; see `app/safety/emergency_guard.py`).

Replies come only from `app/prompts/templates/*.yaml`. The model's job is limited to picking one
intent from a fixed list; none of its words ever reach the user (CLAUDE.md §2.5), which is also why
an out-of-scope question can never be answered by the model.

The classifier code itself lives in `app/tools/intent.py` (shared with the graph); the names below
are re-exported so existing imports keep working.
"""

import asyncio

import structlog

from app.pipeline.base import PipelineContext, PipelineOutput
from app.safety.emergency_guard import EmergencyResult, user_text_from_request
from app.schemas.process import Intent, Language, ProcessRequest, Reply
from app.tools.generic_finder import MedicineFacts
from app.tools.generic_render import DetailItem, render_generic_reply
from app.tools.intent import (
    GENERIC_EXTRACT_PROMPT_ID,
    INTENT_PROMPT_ID,
    MIN_INTENT_CONFIDENCE,
    TEMPLATE_FOR_INTENT,
    ClassifiedIntent,
    GenericQueryExtract,
    IntentResult,
    classify_intent,
    extract_generic_query,
)

__all__ = [
    "GENERIC_EXTRACT_PROMPT_ID",
    "INTENT_PROMPT_ID",
    "MIN_INTENT_CONFIDENCE",
    "ClassifiedIntent",
    "GenericQueryExtract",
    "IntentResult",
    "MinimalPipeline",
]

log = structlog.get_logger("pipeline")


class MinimalPipeline:
    async def run(self, request: ProcessRequest, ctx: PipelineContext) -> PipelineOutput:
        language = request.user.language
        ctx.usage.add_prompt_version(ctx.templates.version)

        user_text = user_text_from_request(request)
        if user_text is None:
            # Image / audio: no LLM call yet (reading the file arrives with M7 / M12 / M13).
            return PipelineOutput(
                intent=Intent.other,
                emergency=False,
                reply=Reply(language=language, text=ctx.templates.get(language, "received_media")),
            )

        # 1. Rules first: no redaction, no model, answer immediately.
        emergency = ctx.guard.check_rules(user_text)

        # 2. Redact. Only this version of the text is ever sent to a model or traced.
        redacted = ""
        if not emergency.is_emergency:
            result = await asyncio.to_thread(ctx.redactor.redact, user_text)
            redacted = result.text
            # 3. Classifier stage (fail-safe: errors and timeouts leave the rules' verdict).
            emergency = await ctx.guard.classify(
                redacted,
                router=ctx.router,
                prompts=ctx.prompts,
                settings=ctx.settings,
                usage=ctx.usage,
            )

        if emergency.is_emergency:
            return self._emergency_output(emergency, language, ctx)

        # 4. Intent, on the redacted text.
        intent = await classify_intent(
            redacted,
            router=ctx.router,
            prompts=ctx.prompts,
            usage=ctx.usage,
            deadline=ctx.deadline,
        )
        if intent is Intent.generic_query and ctx.catalog is not None:
            return await self._generic_query(redacted, language, ctx)
        key = TEMPLATE_FOR_INTENT.get(intent, "coming_soon")
        return PipelineOutput(
            intent=intent,
            emergency=False,
            reply=Reply(language=language, text=ctx.templates.get(language, key)),
        )

    @staticmethod
    def _emergency_output(
        emergency: EmergencyResult, language: Language, ctx: PipelineContext
    ) -> PipelineOutput:
        # Category, source and a count: never the matched words.
        log.warning(
            "emergency_detected",
            category=emergency.category.value if emergency.category else None,
            source=emergency.source,
            matched_terms_count=emergency.matched_terms_count,
        )
        key = "emergency.self_harm" if emergency.kind == "self_harm" else "emergency.general"
        return PipelineOutput(
            intent=Intent.emergency,
            emergency=True,
            emergency_category=emergency.category,
            reply=Reply(language=language, text=ctx.templates.get(language, key)),
        )

    async def _generic_query(
        self, redacted_text: str, language: Language, ctx: PipelineContext
    ) -> PipelineOutput:
        """For "Dolo 650 ka generic batao": the model only copies the medicine name out of the message;
        matching, the salt, strength, price and the reply are deterministic (CLAUDE.md §2.5)."""
        assert ctx.catalog is not None  # noqa: S101 - checked by the caller
        query = await extract_generic_query(
            redacted_text,
            router=ctx.router,
            prompts=ctx.prompts,
            usage=ctx.usage,
            deadline=ctx.deadline,
        )
        if query is None:
            return PipelineOutput(
                intent=Intent.generic_query,
                emergency=False,
                reply=Reply(
                    language=language, text=ctx.templates.get(language, "generic_query_ask_name")
                ),
            )
        name, strength = query
        match = await ctx.catalog.match(name, strength, None)
        if match.note == "catalog_unavailable":  # say so instead of "not in my list"
            return PipelineOutput(
                intent=Intent.generic_query,
                emergency=False,
                reply=Reply(
                    language=language, text=ctx.templates.get(language, "generic_query_unavailable")
                ),
            )
        suggestion = await ctx.catalog.generic(match, MedicineFacts())
        shown = match.brand_name or name  # the catalog's spelling when it knows the product
        text = render_generic_reply([DetailItem(1, shown, strength, suggestion)], language)
        return PipelineOutput(
            intent=Intent.generic_query,
            emergency=False,
            reply=Reply(language=language, text=text),
        )
