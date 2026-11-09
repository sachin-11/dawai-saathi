"""Adapter tests with the HTTP layer mocked: no network, no API keys.

The Anthropic / OpenAI SDKs run on `httpx2`, so the mock is an `httpx2.MockTransport` injected into
the SDK client (respx only patches plain `httpx`).
"""

import base64
import json

import anthropic
import httpx2
import openai
import pytest

from app.llm.anthropic_provider import AnthropicProvider
from app.llm.openai_provider import OpenAIProvider
from app.llm.types import (
    ImageInput,
    LLMAuthError,
    LLMBadRequestError,
    LLMConnectionError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
    Message,
)
from app.tools.intent import IntentResult

MESSAGES = [Message("system", "SYSTEM RULES"), Message("user", "hello 9876543210")]
SECRET_PROMPT = "hello 9876543210"


class Recorder:
    """A mock HTTP server: records requests, answers with a response or raises an exception."""

    def __init__(self, outcome: httpx2.Response | Exception) -> None:
        self.outcome = outcome
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome

    @property
    def body(self) -> dict:
        return json.loads(self.requests[0].content)

    def http_client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(transport=httpx2.MockTransport(self))


def anthropic_provider(recorder: Recorder) -> AnthropicProvider:
    client = anthropic.AsyncAnthropic(
        api_key="sk-test", max_retries=0, http_client=recorder.http_client()
    )
    return AnthropicProvider("sk-test", client=client)


def openai_provider(recorder: Recorder) -> OpenAIProvider:
    client = openai.AsyncOpenAI(
        api_key="sk-test", max_retries=0, http_client=recorder.http_client()
    )
    return OpenAIProvider("sk-test", client=client)


def anthropic_reply(
    content: list[dict], model: str = "claude-test", usage: tuple[int, int] = (11, 7)
):
    return httpx2.Response(
        200,
        json={
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": usage[0], "output_tokens": usage[1]},
        },
    )


def openai_reply(content: str, model: str = "gpt-test", usage: tuple[int, int] = (12, 4)):
    return httpx2.Response(
        200,
        json={
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": 1,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": usage[0],
                "completion_tokens": usage[1],
                "total_tokens": usage[0] + usage[1],
            },
        },
    )


async def generate(provider, **overrides):
    args = {"model": "model-x", "temperature": 0.0, "max_tokens": 64, "timeout_s": 5.0, **overrides}
    return await provider.generate(MESSAGES, **args)


def error_response(status: int) -> httpx2.Response:
    return httpx2.Response(
        status, json={"type": "error", "error": {"type": "x", "message": f"echo: {SECRET_PROMPT}"}}
    )


HTTP_ERRORS: list[tuple[int, type[Exception]]] = [
    (429, LLMRateLimitError),
    (500, LLMServerError),
    (503, LLMServerError),
    (529, LLMServerError),
    (400, LLMBadRequestError),
    (404, LLMBadRequestError),
    (401, LLMAuthError),
    (403, LLMAuthError),
]


class TestAnthropic:
    async def test_plain_text_request_and_response(self):
        rec = Recorder(anthropic_reply([{"type": "text", "text": "hi there"}]))
        raw = await generate(anthropic_provider(rec))

        assert rec.requests[0].url.path == "/v1/messages"
        assert rec.body["model"] == "model-x"
        assert rec.body["system"] == "SYSTEM RULES"
        assert rec.body["messages"] == [{"role": "user", "content": SECRET_PROMPT}]
        assert rec.body["max_tokens"] == 64
        assert "temperature" not in rec.body  # the current SDK takes no sampling parameters
        assert "tools" not in rec.body
        headers = rec.requests[0].headers
        # the SDK sends the key as a header (x-api-key or a bearer token depending on its version)
        assert "sk-test" in (headers.get("x-api-key") or headers.get("authorization") or "")
        assert (
            "sk-test" not in rec.requests[0].content.decode()
        )  # the key is a header, never the body
        assert (raw.text, raw.provider, raw.input_tokens, raw.output_tokens) == (
            "hi there",
            "anthropic",
            11,
            7,
        )

    async def test_structured_output_uses_a_forced_tool_call(self):
        rec = Recorder(
            anthropic_reply(
                [
                    {
                        "type": "tool_use",
                        "id": "t1",
                        "name": "respond",
                        "input": {"intent": "help", "confidence": 0.9},
                    }
                ]
            )
        )
        raw = await generate(anthropic_provider(rec), response_model=IntentResult)

        assert rec.body["tool_choice"] == {"type": "tool", "name": "respond"}
        assert rec.body["tools"][0]["name"] == "respond"
        assert "intent" in rec.body["tools"][0]["input_schema"]["properties"]
        assert json.loads(raw.text) == {"intent": "help", "confidence": 0.9}

    async def test_no_tool_call_in_a_structured_answer_gives_empty_text(self):
        rec = Recorder(anthropic_reply([{"type": "text", "text": "I refuse"}]))
        raw = await generate(anthropic_provider(rec), response_model=IntentResult)
        assert raw.text == ""  # the router will treat this as invalid and repair

    async def test_images_go_in_front_of_the_last_user_message_as_base64(self):
        rec = Recorder(anthropic_reply([{"type": "text", "text": "ok"}]))
        image = ImageInput(data=b"\xff\xd8binary", mime="image/jpeg")
        await generate(anthropic_provider(rec), images=[image])

        content = rec.body["messages"][0]["content"]
        assert content[0]["type"] == "image"
        assert content[0]["source"] == {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": base64.b64encode(b"\xff\xd8binary").decode(),
        }
        assert content[-1] == {"type": "text", "text": SECRET_PROMPT}

    @pytest.mark.parametrize(("status", "expected"), HTTP_ERRORS)
    async def test_http_errors_map_to_the_taxonomy_without_leaking_the_provider_body(
        self, status, expected
    ):
        rec = Recorder(error_response(status))
        with pytest.raises(expected) as info:
            await generate(anthropic_provider(rec))
        assert SECRET_PROMPT not in str(info.value)
        assert "echo" not in str(info.value)

    async def test_timeout_and_connection_errors(self):
        with pytest.raises(LLMTimeoutError):
            await generate(anthropic_provider(Recorder(httpx2.ReadTimeout("slow"))))
        with pytest.raises(LLMConnectionError):
            await generate(anthropic_provider(Recorder(httpx2.ConnectError("down"))))

    async def test_the_sdk_does_not_retry_on_its_own(self):
        rec = Recorder(error_response(500))
        with pytest.raises(LLMServerError):
            await generate(anthropic_provider(rec))
        assert len(rec.requests) == 1  # retrying is the router's job


class TestOpenAI:
    async def test_plain_text_request_and_response(self):
        rec = Recorder(openai_reply("hello!"))
        raw = await generate(openai_provider(rec))

        assert rec.requests[0].url.path == "/v1/chat/completions"
        assert rec.body["model"] == "model-x"
        assert rec.body["messages"] == [
            {"role": "system", "content": "SYSTEM RULES"},
            {"role": "user", "content": SECRET_PROMPT},
        ]
        assert rec.body["max_completion_tokens"] == 64
        assert "response_format" not in rec.body
        assert rec.requests[0].headers["authorization"] == "Bearer sk-test"
        assert (raw.text, raw.provider, raw.input_tokens, raw.output_tokens) == (
            "hello!",
            "openai",
            12,
            4,
        )

    async def test_structured_output_uses_a_json_schema_response_format(self):
        rec = Recorder(openai_reply('{"intent": "help", "confidence": 0.9}'))
        raw = await generate(openai_provider(rec), response_model=IntentResult)

        fmt = rec.body["response_format"]
        assert fmt["type"] == "json_schema"
        assert fmt["json_schema"]["name"] == "IntentResult"
        assert "intent" in fmt["json_schema"]["schema"]["properties"]
        assert json.loads(raw.text)["intent"] == "help"

    async def test_images_become_data_urls(self):
        rec = Recorder(openai_reply("ok"))
        await generate(openai_provider(rec), images=[ImageInput(data=b"abc", mime="image/png")])

        parts = rec.body["messages"][-1]["content"]
        assert parts[0] == {
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{base64.b64encode(b'abc').decode()}"},
        }
        assert parts[-1] == {"type": "text", "text": SECRET_PROMPT}

    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (429, LLMRateLimitError),
            (500, LLMServerError),
            (502, LLMServerError),
            (400, LLMBadRequestError),
            (401, LLMAuthError),
        ],
    )
    async def test_http_errors_map_to_the_taxonomy_without_leaking_the_provider_body(
        self, status, expected
    ):
        rec = Recorder(error_response(status))
        with pytest.raises(expected) as info:
            await generate(openai_provider(rec))
        assert SECRET_PROMPT not in str(info.value)

    async def test_timeout_and_connection_errors(self):
        with pytest.raises(LLMTimeoutError):
            await generate(openai_provider(Recorder(httpx2.ReadTimeout("slow"))))
        with pytest.raises(LLMConnectionError):
            await generate(openai_provider(Recorder(httpx2.ConnectError("down"))))

    async def test_an_answer_without_choices_comes_back_as_empty_text(self):
        rec = Recorder(
            httpx2.Response(
                200,
                json={
                    "id": "c",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "m",
                    "choices": [],
                },
            )
        )
        raw = await generate(openai_provider(rec))
        assert raw.text == "" and raw.input_tokens == 0
