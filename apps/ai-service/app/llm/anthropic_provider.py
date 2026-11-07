"""Anthropic adapter (official SDK).

Structured output uses a FORCED tool call: the model must "call" a tool whose input schema is the
Pydantic model's JSON schema, and the tool input is the structured answer. The router validates it.
"""

import json
import time
from typing import Any

import anthropic
from pydantic import BaseModel

from app.llm.types import (
    ImageInput,
    LLMAuthError,
    LLMBadRequestError,
    LLMConnectionError,
    LLMError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
    Message,
    RawResult,
)

TOOL_NAME = "respond"


def map_anthropic_error(error: Exception) -> LLMError | None:
    """SDK exception -> our taxonomy, or None if it is not an SDK error (a bug: let it surface).

    Never carries the provider's message (it can echo the prompt)."""
    if isinstance(error, anthropic.APITimeoutError):
        return LLMTimeoutError()
    if isinstance(error, anthropic.APIConnectionError):
        return LLMConnectionError()
    if isinstance(error, anthropic.RateLimitError):
        return LLMRateLimitError()
    if isinstance(error, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return LLMAuthError()
    if isinstance(error, anthropic.APIStatusError):
        status = error.status_code
        if status == 408:
            return LLMTimeoutError()
        if status == 429:
            return LLMRateLimitError()
        if status >= 500:  # includes 529 "overloaded"
            return LLMServerError(f"provider returned {status}")
        return LLMBadRequestError(f"provider rejected the request ({status})")
    return None


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str, client: anthropic.AsyncAnthropic | None = None) -> None:
        # max_retries=0: retrying is the router's job (with jitter, deadline and a circuit breaker).
        self._client = client or anthropic.AsyncAnthropic(api_key=api_key, max_retries=0)

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
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        conversation: list[dict[str, Any]] = [
            {"role": m.role, "content": m.content} for m in messages if m.role != "system"
        ]
        if images:
            self._attach_images(conversation, images)

        # Note: `temperature` is accepted by the interface but NOT sent. The current Anthropic SDK
        # (and its newer models) no longer take sampling parameters; determinism comes from the
        # forced tool call and the validated schema instead.
        del temperature
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": conversation,
            "timeout": timeout_s,
        }
        if system:
            kwargs["system"] = system
        if response_model is not None:
            kwargs["tools"] = [
                {
                    "name": TOOL_NAME,
                    "description": "Return the structured answer.",
                    "input_schema": response_model.model_json_schema(),
                }
            ]
            kwargs["tool_choice"] = {"type": "tool", "name": TOOL_NAME}

        started = time.perf_counter()
        try:
            response = await self._client.messages.create(**kwargs)
        except Exception as error:
            mapped = map_anthropic_error(error)
            if mapped is None:
                raise
            raise mapped from None
        latency_ms = round((time.perf_counter() - started) * 1000)

        if response_model is not None:
            tool_input = next(
                (block.input for block in response.content if block.type == "tool_use"), None
            )
            text = json.dumps(tool_input) if tool_input is not None else ""
        else:
            text = "".join(block.text for block in response.content if block.type == "text")

        return RawResult(
            text=text,
            model=response.model,
            provider=self.name,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            latency_ms=latency_ms,
        )

    @staticmethod
    def _attach_images(conversation: list[dict[str, Any]], images: list[ImageInput]) -> None:
        """Put the images in front of the text of the LAST user message."""
        for message in reversed(conversation):
            if message["role"] == "user":
                blocks: list[dict[str, Any]] = [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.mime,
                            "data": image.to_base64(),
                        },
                    }
                    for image in images
                ]
                blocks.append({"type": "text", "text": message["content"]})
                message["content"] = blocks
                return
