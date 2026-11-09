"""POST /v1/synthesize: a short spoken reply (M13). Off unless TTS_ENABLED and a provider is set."""

import base64

import structlog
from fastapi import APIRouter, Depends, Request

from app.api.auth import require_service_token
from app.api.errors import ApiError, api_error_from_llm
from app.llm.tts import SpeechTooLongError, TTSRouter
from app.llm.types import LLMError
from app.schemas.synthesize import SynthesizeRequest, SynthesizeResponse

router = APIRouter(prefix="/v1", tags=["voice"])
log = structlog.get_logger("synthesize")


@router.post(
    "/synthesize",
    response_model=SynthesizeResponse,
    dependencies=[Depends(require_service_token)],
    responses={
        401: {"description": "Missing or wrong X-Service-Token"},
        422: {"description": "Invalid request, or the spoken reply would be too long"},
        503: {"description": "Spoken replies are not enabled / the speech service is down"},
    },
)
async def synthesize(body: SynthesizeRequest, request: Request) -> SynthesizeResponse:
    structlog.contextvars.bind_contextvars(request_id=body.request_id)
    tts: TTSRouter | None = request.app.state.tts
    if tts is None:
        raise ApiError(503, "TTS_NOT_ENABLED", "Spoken replies are not enabled")
    try:
        spoken = await tts.speak(body.text, body.language.value)
    except SpeechTooLongError:
        raise ApiError(422, "SPEECH_TOO_LONG", "The spoken reply would be too long") from None
    except LLMError as error:
        raise api_error_from_llm(error) from None
    # Numbers only: never the text or the audio.
    log.info(
        "synthesize_done",
        provider=spoken.provider,
        model=spoken.model,
        characters=len(body.text),
        duration_s=round(spoken.duration_s, 1),
        cost_usd=spoken.cost_usd,
    )
    return SynthesizeResponse(
        request_id=body.request_id,
        audio_base64=base64.b64encode(spoken.data).decode("ascii"),
        mime=spoken.mime,
        duration_s=spoken.duration_s,
        provider=spoken.provider,
        model=spoken.model,
        cost_usd=spoken.cost_usd,
    )
