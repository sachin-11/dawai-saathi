"""Vision extraction of a prescription (M7): images in, `PrescriptionExtraction` out.

VISION_MODEL, temperature 0, prompt `rx_extract_v1`, structured output. The router already does ONE
repair retry when the answer does not match the schema. If that fails too we do not guess: the
caller gets `None` and answers "I could not read this properly, please confirm with your pharmacist"
with the document marked for review (CLAUDE.md §2.3).
"""

from app.llm.router import Deadline, LLMRouter
from app.llm.types import ImageInput, LLMError, LLMResult, Message
from app.prompts.registry import PromptRegistry
from app.schemas.prescription import PrescriptionExtraction

RX_EXTRACT_PROMPT_ID = "rx_extract_v1"
# A prescription page is dense: allow a generous answer, still bounded.
MAX_OUTPUT_TOKENS = 4000


async def extract_prescription(
    images: list[ImageInput],
    *,
    router: LLMRouter,
    prompts: PromptRegistry,
    deadline: Deadline,
    prompt_id: str = RX_EXTRACT_PROMPT_ID,
) -> tuple[PrescriptionExtraction | None, LLMResult | None]:
    """`(None, None)` when the model could not produce a valid structure even after the repair.

    `prompt_id` is `rx_extract_v1`; the graph's one retry uses the stricter `rx_extract_strict_v1`."""
    prompt = prompts.load(prompt_id)
    messages = [
        prompt.to_message(),
        Message("user", "Read the prescription in the attached image(s) and return the JSON."),
    ]
    try:
        result = await router.generate(
            prompt.model_role,
            messages,
            name="vision_extract_rx",
            temperature=prompt.temperature,
            max_tokens=MAX_OUTPUT_TOKENS,
            response_model=PrescriptionExtraction,
            images=images,
            prompt_version=prompt.version,
            deadline=deadline,
        )
    except LLMError as error:
        if error.kind == "schema":
            return None, None
        raise
    parsed = result.parsed
    if not isinstance(parsed, PrescriptionExtraction):
        return None, result
    return parsed, result
