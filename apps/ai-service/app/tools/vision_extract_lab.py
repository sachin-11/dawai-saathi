"""Vision extraction of a lab report (M12): page images in, `LabReportExtraction` out.

VISION_MODEL, temperature 0, prompt `lab_extract_v1`, structured output. The router already does ONE
repair retry when the answer does not match the schema; the graph retries once more with the stricter
prompt. If that fails too we do not guess: the caller answers "I could not read this report" and the
document is marked for review (CLAUDE.md §2.3).

Everything the model returns under "set by our code" is reset here, and `notes_for_user` is dropped:
model-written text never reaches the user.
"""

from app.llm.router import Deadline, LLMRouter
from app.llm.types import ImageInput, LLMError, LLMResult, Message
from app.prompts.registry import PromptRegistry
from app.schemas.lab_report import LabReportExtraction, LabResult

LAB_EXTRACT_PROMPT_ID = "lab_extract_v1"
LAB_EXTRACT_STRICT_PROMPT_ID = "lab_extract_strict_v1"
# 80 results x ~60 tokens each, with headroom.
MAX_OUTPUT_TOKENS = 8000


def reset_derived(extraction: LabReportExtraction) -> LabReportExtraction:
    """A model-supplied value in a field that only our code may set is thrown away."""
    results = [
        r.model_copy(
            update={
                "test_code": None,
                "value_num": None,
                "value_comparator": "=",
                "value_canonical": None,
                "unit_canonical": None,
                "status": "unknown",
                "range_basis": "none",
                "range_text": None,
                "category": None,
                "needs_confirmation": False,
                "trend": None,
            }
        )
        for r in extraction.results
    ]
    return extraction.model_copy(
        update={
            "results": results,
            "notes_for_user": [],
            "status": "done",
            "has_critical": False,
            "used_general_range": False,
            "unknown_count": 0,
        }
    )


async def extract_lab_report(
    images: list[ImageInput],
    *,
    router: LLMRouter,
    prompts: PromptRegistry,
    deadline: Deadline,
    prompt_id: str = LAB_EXTRACT_PROMPT_ID,
) -> tuple[LabReportExtraction | None, LLMResult | None]:
    """`(None, None)` when the model could not produce a valid structure even after the repair."""
    prompt = prompts.load(prompt_id)
    messages = [
        prompt.to_message(),
        Message("user", "Read the lab report in the attached page image(s) and return the JSON."),
    ]
    try:
        result = await router.generate(
            prompt.model_role,
            messages,
            name="vision_extract_lab",
            temperature=prompt.temperature,
            max_tokens=MAX_OUTPUT_TOKENS,
            response_model=LabReportExtraction,
            images=images,
            prompt_version=prompt.version,
            deadline=deadline,
        )
    except LLMError as error:
        if error.kind == "schema":
            return None, None
        raise
    parsed = result.parsed
    if not isinstance(parsed, LabReportExtraction):
        return None, result
    return reset_derived(parsed), result


__all__ = [
    "LAB_EXTRACT_PROMPT_ID",
    "LAB_EXTRACT_STRICT_PROMPT_ID",
    "LabResult",
    "extract_lab_report",
    "reset_derived",
]
