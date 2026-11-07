"""OpenAI adapter (official SDK, Chat Completions).

Structured output uses the JSON-schema response format built from the Pydantic model; the router
validates the result.
"""

import time
from typing import Any

import openai
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


def map_openai_error(error: Exception) -> LLMError | None:
    """SDK exception -> our taxonomy, or None if it is not an SDK error (a bug: let it surface).

    Never carries the provider's message (it can echo the prompt)."""
    if isinstance(error, openai.APITimeoutError):
        return LLMTimeoutError()
    if isinstance(error, openai.APIConnectionError):
        return LLMConnectionError()
    if isinstance(error, openai.RateLimitError):
        return LLMRateLimitError()
    if isinstance(error, (openai.AuthenticationError, openai.PermissionDeniedError)):
        return LLMAuthError()
    if isinstance(error, openai.APIStatusError):
        status = error.status_code
        if status == 408:
            return LLMTimeoutError()
        if status == 429:
            return LLMRateLimitError()
        if status >= 500:
            return LLMServerError(f"provider returned {status}")
        return LLMBadRequestError(f"provider rejected the request ({status})")
    return None


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str, client: openai.AsyncOpenAI | None = None) -> None:
        # max_retries=0: retrying is the router's job (with jitter, deadline and a circuit breaker).
        self._client = client or openai.AsyncOpenAI(api_key=api_key, max_retries=0)

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
        payload: list[dict[str, Any]] = [{"role": m.role, "content": m.content} for m in messages]
        if images:
            self._attach_images(payload, images)

        kwargs: dict[str, Any] = {
            "model": model,
            "messages": payload,
            "temperature": temperature,
            "max_completion_tokens": max_tokens,
            "timeout": timeout_s,
        }
        if response_model is not None:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": response_model.__name__,
                    "schema": response_model.model_json_schema(),
                    "strict": False,
                },
            }

        started = time.perf_counter()
        try:
            response = await self._client.chat.completions.create(**kwargs)
        except Exception as error:
            mapped = map_openai_error(error)
            if mapped is None:
                raise
            raise mapped from None
        latency_ms = round((time.perf_counter() - started) * 1000)

        choice = response.choices[0] if response.choices else None
        text = (choice.message.content if choice else None) or ""
        usage = response.usage
        return RawResult(
            text=text,
            model=response.model,
            provider=self.name,
            input_tokens=usage.prompt_tokens if usage else 0,
            output_tokens=usage.completion_tokens if usage else 0,
            latency_ms=latency_ms,
        )

    @staticmethod
    def _attach_images(payload: list[dict[str, Any]], images: list[ImageInput]) -> None:
        """Put the images in front of the text of the LAST user message."""
        for message in reversed(payload):
            if message["role"] == "user":
                parts: list[dict[str, Any]] = [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{image.mime};base64,{image.to_base64()}"},
                    }
                    for image in images
                ]
                parts.append({"type": "text", "text": message["content"]})
                message["content"] = parts
                return
