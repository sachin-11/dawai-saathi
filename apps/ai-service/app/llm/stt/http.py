"""Shared HTTP plumbing of the speech adapters: one error taxonomy (the same as the LLM layer's),
so the router's retry/fallback rules are identical. Messages are generic on purpose: a provider's
error body can echo what it was sent."""

import httpx

from app.llm.types import (
    LLMAuthError,
    LLMBadRequestError,
    LLMConnectionError,
    LLMError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
)


def error_for_status(status: int) -> LLMError:
    if status == 429:
        return LLMRateLimitError("speech provider rate limit")
    if status in (401, 403):
        return LLMAuthError("speech provider rejected the credentials")
    if status >= 500 or status in (408, 409):
        return LLMServerError(f"speech provider error {status}")
    return LLMBadRequestError(f"speech provider rejected the request ({status})")


async def post_multipart(
    client: httpx.AsyncClient | None,
    url: str,
    *,
    headers: dict[str, str],
    data: dict[str, str],
    files: dict[str, tuple[str, bytes, str]],
    timeout_s: float,
) -> httpx.Response:
    """POST and map every transport failure to the LLM error taxonomy."""
    owns = client is None
    http = client or httpx.AsyncClient()
    try:
        response = await http.post(url, headers=headers, data=data, files=files, timeout=timeout_s)
    except httpx.TimeoutException:
        raise LLMTimeoutError("speech provider timed out") from None
    except httpx.HTTPError:
        raise LLMConnectionError("speech provider unreachable") from None
    finally:
        if owns:
            await http.aclose()
    if response.status_code != 200:
        raise error_for_status(response.status_code)
    return response


async def post_json(
    client: httpx.AsyncClient | None,
    url: str,
    *,
    headers: dict[str, str],
    body: dict[str, object],
    timeout_s: float,
) -> httpx.Response:
    owns = client is None
    http = client or httpx.AsyncClient()
    try:
        response = await http.post(url, headers=headers, json=body, timeout=timeout_s)
    except httpx.TimeoutException:
        raise LLMTimeoutError("speech provider timed out") from None
    except httpx.HTTPError:
        raise LLMConnectionError("speech provider unreachable") from None
    finally:
        if owns:
            await http.aclose()
    if response.status_code != 200:
        raise error_for_status(response.status_code)
    return response
