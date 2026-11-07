"""The minimal pipeline (M5, extended in M6, replaced by the LangGraph pipeline in M9).

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
"""

import asyncio
from enum import StrEnum

import structlog
from pydantic import BaseModel, Field

from app.llm.types import Message
from app.pipeline.base import PipelineContext, PipelineOutput
from app.safety.emergency_guard import EmergencyResult, user_text_from_request
from app.schemas.process import Intent, Language, ProcessRequest, Reply

INTENT_PROMPT_ID = "intent_text_v2"
# Below this the classification is treated as "other": a guess must not trigger a specific answer.
MIN_INTENT_CONFIDENCE = 0.5

log = structlog.get_logger("pipeline")


class ClassifiedIntent(StrEnum):
    """What the classifier may answer (prompt `intent_text_v2`). Mapped to the contract's `Intent`."""

    prescription_question = "prescription_question"
    lab_question = "lab_question"
    generic_query = "generic_query"
    interaction_query = "interaction_query"
    help = "help"
    greeting = "greeting"
    out_of_scope = "out_of_scope"


_TO_CONTRACT_INTENT = {
    ClassifiedIntent.prescription_question: Intent.prescription,
    ClassifiedIntent.lab_question: Intent.lab_report,
    ClassifiedIntent.generic_query: Intent.generic_query,
    ClassifiedIntent.interaction_query: Intent.interaction_query,
    ClassifiedIntent.help: Intent.help,
    ClassifiedIntent.greeting: Intent.greeting,
    ClassifiedIntent.out_of_scope: Intent.out_of_scope,
}

_TEMPLATE_FOR_INTENT = {
    Intent.help: "help",
    Intent.greeting: "greeting",
    Intent.out_of_scope: "out_of_scope",
    Intent.other: "help",  # unclear message: show what the assistant can do
}


class IntentResult(BaseModel):
    """Structured output of the intent classifier."""

    intent: ClassifiedIntent
    confidence: float = Field(ge=0.0, le=1.0)


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
        intent = await self._classify(redacted, ctx)
        key = _TEMPLATE_FOR_INTENT.get(intent, "coming_soon")
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

    async def _classify(self, redacted_text: str, ctx: PipelineContext) -> Intent:
        prompt = ctx.prompts.load(INTENT_PROMPT_ID)
        messages = [
            prompt.to_message(
                allowed_intents=", ".join(intent.value for intent in ClassifiedIntent)
            ),
            # The user's text is DATA: passed as-is (never rendered as a template) and delimited.
            Message("user", f"<message>\n{redacted_text}\n</message>"),
        ]
        result = await ctx.router.generate(
            prompt.model_role,
            messages,
            name="classify_intent",
            temperature=prompt.temperature,
            max_tokens=100,
            response_model=IntentResult,
            prompt_version=prompt.version,
            deadline=ctx.deadline,
        )
        ctx.usage.add(result, prompt.version)

        parsed = result.parsed
        if not isinstance(parsed, IntentResult) or parsed.confidence < MIN_INTENT_CONFIDENCE:
            return Intent.other
        return _TO_CONTRACT_INTENT[parsed.intent]
