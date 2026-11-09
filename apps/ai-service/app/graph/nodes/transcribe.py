"""transcribe: a voice note becomes text, then travels the SAME graph as typed text (M13, CLAUDE.md §7.6).

  fetch (SSRF-safe, in memory) -> duration limit -> STT router (primary, fallback, ffmpeg if needed)
  -> `raw_text` (as returned) + `roman_text` (Roman copy for keyword matching)

Everything after this node is the typed-text path: the emergency guard runs on BOTH scripts first,
then redaction, classification and the usual branches. Two failures never reach the model at all and
get a static reply: a note that is too long (not transcribed, nothing sent to a provider) and a speech
service that is down (the reply also names 112/108, because we could not check the note).

A transcript that is empty, very short or low-confidence is NOT dropped here: it still goes to the
emergency guard ("whatever partial text exists"), and `voice_unclear` makes the graph ask the user to
repeat or type only AFTER both emergency stages found nothing.

Logs and traces carry `[audio: 23 s, ogg]` plus provider/model/latency/cost: never the audio, never
the transcript (it is PHI until `redact`).
"""

import unicodedata
from typing import Any

import structlog

from app.graph.nodes._util import static_reply
from app.graph.state import GraphState
from app.graph.traced import traced_node
from app.llm.stt.audio import normalise_audio_mime, probe_duration
from app.llm.stt.types import AudioUnreadableError, LanguageHint, describe_audio
from app.llm.types import LLMConfigError, LLMError
from app.media.fetcher import MediaRejectedError, fetch_media
from app.observability.metrics import METRICS
from app.pipeline.base import PipelineContext
from app.safety.translit import has_devanagari, to_roman
from app.schemas.process import Intent

log = structlog.get_logger("stt")


def _enough_speech(text: str, min_chars: int) -> bool:
    """Letters, digits AND combining marks count: Devanagari vowel signs are marks, and "ले ली" is a
    real (four-character) answer."""
    return sum(1 for ch in text if unicodedata.category(ch)[0] in "LNM") >= min_chars


def language_hint(state: GraphState, ctx: PipelineContext) -> LanguageHint:
    if ctx.settings.stt_language_mode == "auto":
        return "auto"
    return "hi" if state.request.user.language.value == "hi" else "en"


@traced_node("transcribe", timeout="stt")
async def transcribe(state: GraphState, ctx: PipelineContext) -> dict[str, Any]:
    payload = state.request.input
    assert payload.media_url is not None and payload.mime is not None  # noqa: S101 - contract
    if ctx.stt is None:
        return static_reply("voice.stt_unavailable", Intent.other)

    try:
        media = await fetch_media(payload.media_url, payload.mime, ctx.settings)
    except MediaRejectedError as error:
        log.warning("voice_fetch_rejected", code=error.code)
        return static_reply("voice.unreadable", Intent.other)

    mime = normalise_audio_mime(media.mime)
    probed = probe_duration(media.data, mime)
    if probed is not None and probed > ctx.settings.max_audio_seconds:
        log.info("voice_too_long", audio=describe_audio(probed, mime))
        return static_reply("voice.too_long", Intent.other)

    try:
        result = await ctx.stt.transcribe(
            media.data, mime, language_hint(state, ctx), deadline=ctx.deadline
        )
    except AudioUnreadableError:
        log.warning("voice_undecodable", audio=describe_audio(probed, mime))
        return {"voice_unclear": True, "raw_text": "", "audio_seconds": probed}
    except LLMConfigError as error:
        log.error("voice_stt_misconfigured", kind=error.kind)
        return static_reply("voice.stt_unavailable", Intent.other)
    except LLMError as error:
        log.error("voice_stt_unavailable", kind=error.kind)
        return static_reply("voice.stt_unavailable", Intent.other)

    ctx.usage.cost_usd += result.cost_usd
    ctx.usage.fallback_used = ctx.usage.fallback_used or result.fallback_used
    log.info(
        "stt_done",
        audio=describe_audio(result.duration_s, mime),
        provider=result.provider,
        model=result.model,
        latency_ms=result.latency_ms,
        cost_usd=result.cost_usd,
        confidence=result.confidence,
        fallback_used=result.fallback_used,
        language=result.language,
    )
    if result.duration_s > ctx.settings.max_audio_seconds:
        return static_reply("voice.too_long", Intent.other)

    text = result.text.strip()
    unclear = not _enough_speech(text, ctx.settings.stt_min_chars) or (
        result.confidence is not None and result.confidence < ctx.settings.stt_min_confidence
    )
    if unclear:
        METRICS.count_stt_low_confidence()
    return {
        "raw_text": text,
        "roman_text": to_roman(text) if has_devanagari(text) else None,
        "voice_unclear": unclear,
        "audio_seconds": result.duration_s,
    }
