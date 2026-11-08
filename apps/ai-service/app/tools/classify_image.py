"""Cheap image classification: prescription / lab report / medicine strip / other (M7).

Runs on the CHEAP_MODEL (it must accept images) before the expensive extraction. A low-confidence
or failed classification is treated as "other": the user is asked for a clearer photo instead of
paying for (and trusting) a vision extraction of something that may not be a prescription.
"""

from app.llm.router import Deadline, LLMRouter
from app.llm.types import ImageInput, LLMError, LLMResult, Message
from app.prompts.registry import PromptRegistry
from app.schemas.image_classify import ImageClassification

IMAGE_CLASSIFY_PROMPT_ID = "image_classify_v1"
MIN_CLASSIFY_CONFIDENCE = 0.5


async def classify_image(
    images: list[ImageInput],
    *,
    router: LLMRouter,
    prompts: PromptRegistry,
    deadline: Deadline,
) -> tuple[ImageClassification, LLMResult | None]:
    """`(classification, llm_result)`; the result is None when the call failed (kind "other")."""
    prompt = prompts.load(IMAGE_CLASSIFY_PROMPT_ID)
    messages = [prompt.to_message(), Message("user", "Classify the attached picture.")]
    try:
        result = await router.generate(
            prompt.model_role,
            messages,
            name="classify_image",
            temperature=prompt.temperature,
            max_tokens=100,
            response_model=ImageClassification,
            images=images[:1],  # the first page is enough to tell the document type
            prompt_version=prompt.version,
            deadline=deadline,
        )
    except LLMError as error:
        if error.kind != "schema":
            # Outage, auth, config: surface it (the gateway retries and tells the user), never
            # disguise it as "other". Only a model that answered in a broken structure is "other".
            raise
        return ImageClassification(kind="other", quality="poor", confidence=0.0), None

    parsed = result.parsed
    if not isinstance(parsed, ImageClassification) or parsed.confidence < MIN_CLASSIFY_CONFIDENCE:
        return ImageClassification(kind="other", quality="poor", confidence=0.0), result
    return parsed, result
