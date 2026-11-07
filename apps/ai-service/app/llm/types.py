"""Types shared by the LLM layer: messages, results and the error taxonomy.

The taxonomy decides what the router does (CLAUDE.md §8, M5):

| error                  | retry same provider | fall back to the other provider |
|------------------------|---------------------|---------------------------------|
| LLMTimeoutError        | yes                 | yes                             |
| LLMRateLimitError      | yes                 | yes                             |
| LLMServerError (5xx)   | yes                 | yes                             |
| LLMConnectionError     | yes                 | yes                             |
| LLMBadRequestError     | no                  | NO (the request itself is wrong)|
| LLMAuthError           | no                  | NO (a misconfiguration; fix it) |
| LLMSchemaError         | no                  | NO (the model answered badly)   |

Error messages are generic on purpose: provider error bodies can echo the prompt, which is PHI.
"""

import base64
from dataclasses import dataclass, field
from typing import Literal, Protocol

from pydantic import BaseModel

Role = Literal["system", "user", "assistant"]
ModelRole = Literal["vision", "text", "cheap"]


@dataclass(frozen=True, slots=True)
class Message:
    role: Role
    content: str


@dataclass(frozen=True, slots=True)
class ImageInput:
    """An image held in memory for ONE request (never written to disk or logged)."""

    data: bytes
    mime: str

    def to_base64(self) -> str:
        return base64.b64encode(self.data).decode("ascii")

    @property
    def size_kb(self) -> int:
        return max(1, round(len(self.data) / 1024))

    def describe(self) -> str:
        """What traces and logs show instead of the image itself."""
        return f"[image: {self.mime}, {self.size_kb} KB]"


@dataclass(frozen=True, slots=True)
class LLMResult:
    """One answered LLM request, as seen by the rest of the app."""

    text: str | None
    parsed: BaseModel | None
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    cost_usd: float = 0.0
    fallback_used: bool = False
    attempts: int = 1


@dataclass(frozen=True, slots=True)
class RawResult:
    """What a provider adapter returns: no cost, no fallback info (the router adds those)."""

    text: str
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    latency_ms: int


@dataclass(frozen=True, slots=True)
class LLMCallRecord:
    """One attempt against one provider, successful or not. Fed to the tracer."""

    name: str
    provider: str
    model: str
    attempt: int
    ok: bool
    error_kind: str | None
    input_tokens: int
    output_tokens: int
    latency_ms: int
    cost_usd: float
    prompt_version: str | None
    messages: tuple[Message, ...] = field(default=())
    images: tuple[ImageInput, ...] = field(default=())
    output_text: str | None = None


class LLMError(Exception):
    """Base class. `kind` is a stable short token for logs and traces."""

    kind = "error"
    retryable = False
    fallback_ok = False

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.kind)


class LLMTimeoutError(LLMError):
    kind, retryable, fallback_ok = "timeout", True, True


class LLMRateLimitError(LLMError):
    kind, retryable, fallback_ok = "rate_limit", True, True


class LLMServerError(LLMError):
    kind, retryable, fallback_ok = "server_error", True, True


class LLMConnectionError(LLMError):
    kind, retryable, fallback_ok = "connection", True, True


class LLMBadRequestError(LLMError):
    kind = "bad_request"


class LLMAuthError(LLMError):
    kind = "auth"


class LLMSchemaError(LLMError):
    """The model answered, but not in the required structure, even after one repair attempt."""

    kind = "schema"


class LLMConfigError(LLMError):
    kind = "config"


class LLMUnavailableError(LLMError):
    """Every usable provider failed (or was skipped by its circuit breaker)."""

    kind = "unavailable"


class LLMProvider(Protocol):
    """What the router needs from a provider adapter."""

    name: str

    async def generate(
        self,
        messages: list[Message],
        *,
        model: str,
        temperature: float,
        max_tokens: int,
        response_model: type[BaseModel] | None = None,
        images: list[ImageInput] | None = None,
        timeout_s: float,
    ) -> RawResult:
        """Return the raw answer. With `response_model`, `text` is the JSON the model produced."""
        ...
