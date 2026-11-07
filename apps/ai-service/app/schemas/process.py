"""The `/v1/process` contract (CLAUDE.md §8.1).

This file is the single source of truth: `make contracts` exports it as OpenAPI
(`packages/contracts/openapi/ai-service.json`) and the gateway's TypeScript types are GENERATED from
that file, never written by hand. Change a model here, run `make contracts`, commit both outputs;
CI fails if they are out of date.
"""

from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

# A WhatsApp message id (the gateway uses it as request id) or a UUID. Restricted to a log-safe
# alphabet: no spaces, quotes or control characters (log injection).
RequestId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._=+/-]{1,200}$")]

MAX_REPLY_CHARS = 4096
MAX_BUTTONS = 3
MAX_BUTTON_TITLE_CHARS = 20
MAX_BUTTON_ID_CHARS = 256
MAX_INPUT_TEXT_CHARS = 4000


class Language(StrEnum):
    hi = "hi"
    en = "en"


class InputType(StrEnum):
    image = "image"
    text = "text"
    audio = "audio"


class Intent(StrEnum):
    prescription = "prescription"
    lab_report = "lab_report"
    generic_query = "generic_query"
    interaction_query = "interaction_query"
    help = "help"
    emergency = "emergency"
    other = "other"


class WarningType(StrEnum):
    low_confidence = "low_confidence"
    interaction = "interaction"
    critical_value = "critical_value"


class _Strict(BaseModel):
    """Request models reject unknown fields: a typo or a drifting client fails loudly."""

    model_config = ConfigDict(extra="forbid")


# ------------------------------------------------------------------ request


class UserContext(_Strict):
    language: Language
    age: int | None = Field(default=None, ge=0, le=120)
    sex: Literal["m", "f"] | None = None


class InputPayload(_Strict):
    type: InputType
    text: str | None = Field(default=None, max_length=MAX_INPUT_TEXT_CHARS)
    # Presigned S3 URL (5 minutes). Only hosts in ALLOWED_MEDIA_HOSTS are ever fetched.
    media_url: str | None = Field(default=None, max_length=2048)
    mime: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def _shape_matches_type(self) -> Self:
        if self.type is InputType.text:
            if self.text is None or not self.text.strip():
                raise ValueError("text input requires a non-empty `text`")
            if self.media_url is not None:
                raise ValueError("text input must not carry `media_url`")
        elif self.media_url is None or self.mime is None:
            raise ValueError(f"{self.type.value} input requires `media_url` and `mime`")
        return self


class ActiveMedication(_Strict):
    salt: str = Field(min_length=1, max_length=200)
    strength: str = Field(min_length=1, max_length=50)


class RequestContext(_Strict):
    active_medications: list[ActiveMedication] = Field(default_factory=list, max_length=50)


class ProcessRequest(_Strict):
    request_id: RequestId
    user: UserContext
    input: InputPayload
    context: RequestContext = Field(default_factory=RequestContext)


# ------------------------------------------------------------------ response


class PlaceholderExtraction(BaseModel):
    """Stand-in until real extraction schemas arrive (prescription: M7, lab report: M12).

    `extraction` is discriminated by `kind`; M7/M12 turn `Extraction` into a tagged union of the
    real payloads and this placeholder disappears.
    """

    kind: Literal["placeholder"] = "placeholder"


Extraction = PlaceholderExtraction


class Warning(BaseModel):
    type: WarningType
    detail: str = Field(max_length=500)


class ReplyButton(BaseModel):
    id: str = Field(min_length=1, max_length=MAX_BUTTON_ID_CHARS)
    title: str = Field(min_length=1, max_length=MAX_BUTTON_TITLE_CHARS)


class Reply(BaseModel):
    language: Language
    text: str = Field(min_length=1, max_length=MAX_REPLY_CHARS)
    buttons: list[ReplyButton] = Field(default_factory=list, max_length=MAX_BUTTONS)


class Meta(BaseModel):
    model: str | None = None
    prompt_version: str
    latency_ms: int = Field(ge=0)
    cost_usd: float = Field(ge=0)
    trace_id: str | None = None
    # Additions to §8.1, useful for logs and for spotting a fallback in production.
    provider: str | None = None
    fallback_used: bool = False


class ProcessResponse(BaseModel):
    request_id: RequestId
    intent: Intent
    emergency: bool = False
    extraction: Extraction | None = None
    warnings: list[Warning] = Field(default_factory=list)
    reply: Reply
    meta: Meta
