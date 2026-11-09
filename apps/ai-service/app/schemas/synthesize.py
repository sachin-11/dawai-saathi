"""`POST /v1/synthesize` (M13): text -> one Ogg/Opus voice message. The gateway sends only the
`spoken_text` it received from `/v1/process`; the AI service never sends WhatsApp messages."""

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.process import Language, RequestId


class SynthesizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: RequestId
    language: Language
    text: str = Field(min_length=1, max_length=1200)


class SynthesizeResponse(BaseModel):
    request_id: RequestId
    audio_base64: str  # Ogg/Opus, mono: what WhatsApp plays as a voice message
    mime: str = "audio/ogg"
    duration_s: float = Field(ge=0)
    provider: str
    model: str
    cost_usd: float = Field(ge=0)
