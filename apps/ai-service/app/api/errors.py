"""API errors with a stable machine-readable `code`, rendered in the shared error body shape."""

from starlette.exceptions import HTTPException as StarletteHTTPException

from app.llm.types import (
    LLMAuthError,
    LLMBadRequestError,
    LLMConfigError,
    LLMError,
    LLMSchemaError,
    LLMUnavailableError,
)


class ApiError(StarletteHTTPException):
    """An HTTP error that carries its own `code` (e.g. PROCESS_TIMEOUT) next to the status."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(status_code=status_code, detail=message)
        self.code = code


def api_error_from_llm(error: LLMError) -> ApiError:
    """Translate an LLM failure into a response. Messages are generic: never the provider's body."""
    if isinstance(error, LLMUnavailableError):
        return ApiError(503, "LLM_UNAVAILABLE", "The language model is temporarily unavailable")
    if isinstance(error, LLMConfigError):
        return ApiError(503, "LLM_NOT_CONFIGURED", "The language model is not configured")
    if isinstance(error, LLMSchemaError):
        return ApiError(502, "LLM_BAD_OUTPUT", "The language model returned an unusable answer")
    if isinstance(error, (LLMBadRequestError, LLMAuthError)):
        return ApiError(502, "LLM_REJECTED", "The language model rejected the request")
    return ApiError(502, "LLM_ERROR", "The language model failed")
