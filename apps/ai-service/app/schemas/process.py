"""The `/v1/process` contract (CLAUDE.md §8.1).

This file is the single source of truth: `make contracts` exports it as OpenAPI
(`packages/contracts/openapi/ai-service.json`) and the gateway's TypeScript types are GENERATED from
that file, never written by hand. Change a model here, run `make contracts`, commit both outputs;
CI fails if they are out of date.
"""

from datetime import date
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.schemas.interactions import InteractionReport
from app.schemas.lab_report import LabReportExtraction
from app.schemas.prescription import PrescriptionExtraction

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
    greeting = "greeting"
    out_of_scope = "out_of_scope"
    other = "other"


class EmergencyCategory(StrEnum):
    """Why a message was treated as an emergency (shared with the keyword file's categories)."""

    cardiac = "cardiac"
    breathing = "breathing"
    unconscious = "unconscious"
    bleeding = "bleeding"
    poisoning_overdose = "poisoning_overdose"
    seizure = "seizure"
    stroke = "stroke"
    severe_allergy = "severe_allergy"
    self_harm = "self_harm"


class Command(StrEnum):
    """A command recognised in a voice note (`detected_command`). The gateway executes it; DELETE
    still needs the button confirmation, caregiver commands are never detected by voice."""

    help = "help"
    language = "language"
    delete = "delete"
    stop_reminders = "stop_reminders"
    start_reminders = "start_reminders"
    meds = "meds"
    check = "check"
    reports = "reports"
    reminders = "reminders"
    voice_on = "voice_on"
    voice_off = "voice_off"
    reminder_taken = "reminder_taken"
    reminder_snooze = "reminder_snooze"
    reminder_skip = "reminder_skip"


class WarningType(StrEnum):
    low_confidence = "low_confidence"
    interaction = "interaction"
    duplicate_ingredient = "duplicate_ingredient"
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
    # Null when the medicine has no certain salt / strength (it is then reported as "not checked").
    salt: str | None = Field(default=None, min_length=1, max_length=200)
    strength: str | None = Field(default=None, min_length=1, max_length=50)
    # M11: what the interaction checker needs. All optional so an older gateway keeps working.
    medication_id: str | None = Field(default=None, max_length=64)
    name: str | None = Field(default=None, max_length=200)  # as the user knows it ("Dolo 650")
    salt_key: str | None = Field(default=None, max_length=200)  # canonical, "a+b" for combinations
    strength_key: str | None = Field(default=None, max_length=100)


class PreviousLabResult(_Strict):
    """M12: one result of an earlier lab report, in the test's CANONICAL unit. Nothing else about the
    earlier report is sent (no name, lab or document id)."""

    test_code: str = Field(min_length=1, max_length=32)
    value: float
    unit: str = Field(max_length=32)
    report_date: date


class RequestContext(_Strict):
    active_medications: list[ActiveMedication] = Field(default_factory=list, max_length=50)
    # M12: results of the user's lab reports of the last 12 months, for the "since last report" lines.
    previous_lab_results: list[PreviousLabResult] = Field(default_factory=list, max_length=600)


class RequestOptions(_Strict):
    # Ask for `debug_trace` in the response. Honoured ONLY for the demo client (DEMO_SERVICE_TOKEN);
    # the gateway never sets it, and for any other caller it is ignored.
    include_trace: bool = False
    # M13: the user has spoken replies on: also return `spoken_text` when the reply may be spoken.
    want_spoken: bool = False


class ProcessRequest(_Strict):
    request_id: RequestId
    user: UserContext
    input: InputPayload
    context: RequestContext = Field(default_factory=RequestContext)
    options: RequestOptions = Field(default_factory=RequestOptions)


# ------------------------------------------------------------------ response


# `extraction` is the intent-specific structured payload, a union discriminated by `kind`
# (M12: prescription | lab_report).
Extraction = Annotated[PrescriptionExtraction | LabReportExtraction, Field(discriminator="kind")]


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


class TraceEntry(BaseModel):
    """One graph node as the demo's trace view shows it. NEVER any text, extraction value or PHI."""

    node: str
    latency_ms: int = Field(ge=0)
    status: Literal["ok", "error", "timeout", "fallback"]
    model: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    cost_usd: float | None = None
    prompt_version: str | None = None


class ProcessResponse(BaseModel):
    request_id: RequestId
    intent: Intent
    emergency: bool = False
    # Set only when `emergency` is true. The gateway audits it (category only, never the text).
    emergency_category: EmergencyCategory | None = None
    extraction: Extraction | None = None
    warnings: list[Warning] = Field(default_factory=list)
    # M11: structured interaction / duplicate-ingredient findings (null when no check ran).
    interactions: InteractionReport | None = None
    reply: Reply
    meta: Meta
    # M13 (voice notes): a command found in the transcript (the gateway executes it), the first
    # 120 characters of the REDACTED transcript for the "you asked" line, and a short text that may be
    # read aloud (only when `options.want_spoken` and the reply is allowed to be spoken).
    detected_command: Command | None = None
    transcript_redacted_short: str | None = Field(default=None, max_length=120)
    spoken_text: str | None = Field(default=None, max_length=1200)
    # Per-node trace for the web demo: present only for the demo client that asked for it.
    debug_trace: list[TraceEntry] | None = None
