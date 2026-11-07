"""The minimal pipeline (M5, replaced by the LangGraph pipeline in M9).

  text  -> classify the intent with the CHEAP model (structured output), then answer from a STATIC
           template: help -> help text, emergency -> 112/108 text, anything else -> "coming soon"
  image / audio -> no LLM call yet; a static "received, coming soon" text

Replies come only from `app/prompts/templates/*.yaml`. The model's job is limited to picking one
intent from a fixed list; none of its words ever reach the user (CLAUDE.md §2.5).
"""

from pydantic import BaseModel, Field

from app.llm.types import Message
from app.pipeline.base import PipelineContext, PipelineOutput
from app.schemas.process import InputType, Intent, ProcessRequest, Reply

INTENT_PROMPT_ID = "intent_text_v1"
# Below this the classification is treated as "other": a guess must not trigger a specific answer.
MIN_INTENT_CONFIDENCE = 0.5


class IntentResult(BaseModel):
    """Structured output of the intent classifier."""

    intent: Intent
    confidence: float = Field(ge=0.0, le=1.0)


class MinimalPipeline:
    async def run(self, request: ProcessRequest, ctx: PipelineContext) -> PipelineOutput:
        language = request.user.language
        ctx.usage.add_prompt_version(ctx.templates.version)

        if request.input.type is not InputType.text:
            # No LLM call yet (reading the file arrives with M7 / M12 / M13).
            return PipelineOutput(
                intent=Intent.other,
                emergency=False,
                reply=Reply(language=language, text=ctx.templates.get(language, "received_media")),
            )

        intent = await self._classify(request, ctx)
        if intent is Intent.emergency:
            key = "emergency"
        elif intent is Intent.help:
            key = "help"
        else:
            key = "coming_soon"
        return PipelineOutput(
            intent=intent,
            emergency=intent is Intent.emergency,
            reply=Reply(language=language, text=ctx.templates.get(language, key)),
        )

    async def _classify(self, request: ProcessRequest, ctx: PipelineContext) -> Intent:
        prompt = ctx.prompts.load(INTENT_PROMPT_ID)
        messages = [
            prompt.to_message(allowed_intents=", ".join(intent.value for intent in Intent)),
            # The user's text is DATA: passed as-is (never rendered as a template) and delimited.
            Message("user", f"<message>\n{request.input.text or ''}\n</message>"),
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
        return parsed.intent
