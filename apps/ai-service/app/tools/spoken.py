"""What may be READ ALOUD, and the voice-note helpers of the final reply (M13, CLAUDE.md §2.5).

Spoken replies are an addition to the text reply, never a replacement, and only for replies that
are short and already verified:

  speak the reply itself   interaction question, lab-test question (template text the verifier passed,
                           length-capped so it stays under ~45 s)
  speak a SHORT SUMMARY    prescription (count + readable medicine names), lab report (counts, and the
                           "contact your doctor today" sentence when a value is critical)
  NEVER speak              emergencies (the text must arrive instantly), generic price lists, help and
                           greeting texts, anything that did not pass the verifier, any reply to a
                           command

Every spoken sentence comes from a fixed template filled with extracted values (names, counts): no
model wrote any of it. The text reply that carries the full detail is always sent as well.
"""

from typing import Final

from app.graph.state import GraphState
from app.pipeline.base import PipelineContext
from app.schemas.process import Intent
from app.tools.rx_compose import build_views

MAX_SPOKEN_CHARS: Final = 600  # about 40 seconds of speech
MAX_SPOKEN_NAMES: Final = 5
ABNORMAL: Final = frozenset(
    {"high", "low", "critical_high", "critical_low", "qualitative_abnormal"}
)
CRITICAL: Final = frozenset({"critical_high", "critical_low"})
TRANSCRIPT_SHORT_CHARS: Final = 120


def short_transcript(redacted: str | None) -> str | None:
    """The first 120 characters of the REDACTED transcript on one line, or None."""
    if not redacted:
        return None
    one_line = " ".join(redacted.split())
    if not one_line:
        return None
    if len(one_line) <= TRANSCRIPT_SHORT_CHARS:
        return one_line
    return one_line[: TRANSCRIPT_SHORT_CHARS - 1].rstrip() + "…"


def build_spoken_text(state: GraphState, ctx: PipelineContext) -> str | None:
    """The text to synthesise, or None when this reply must not be spoken."""
    emergency = state.emergency
    if emergency is not None and emergency.is_emergency:
        return None
    if state.detected_command is not None or state.reply is None:
        return None
    if state.reply_source != "template" and state.intent is not Intent.prescription:
        return None
    verification = state.verification
    if verification is not None and not verification.ok:
        return None
    if state.errors and any(e.node == "verifier" for e in state.errors):
        return None

    language = state.request.user.language
    reply_text = state.reply.text

    if state.intent is Intent.interaction_query and state.interaction_report is not None:
        return reply_text if len(reply_text) <= MAX_SPOKEN_CHARS else None
    if state.intent is Intent.lab_report and state.lab_question_text is not None:
        return reply_text if len(reply_text) <= MAX_SPOKEN_CHARS else None
    if state.intent is Intent.lab_report and state.lab_extraction is not None:
        results = state.lab_extraction.results
        if not results:
            return None
        text = ctx.templates.get(language, "spoken.lab_summary").format(
            total=len(results), abnormal=sum(1 for r in results if r.status in ABNORMAL)
        )
        if any(r.status in CRITICAL for r in results):
            text += " " + ctx.templates.get(language, "spoken.lab_critical")
        return text
    if state.intent is Intent.prescription and state.rx_extraction is not None:
        views = build_views(state.rx_extraction, ctx.settings.extraction_min_confidence)
        names = [v.name for v in views if v.name and not v.low]
        if not names:
            return None
        return ctx.templates.get(language, "spoken.rx_summary").format(
            count=len(names), names=", ".join(names[:MAX_SPOKEN_NAMES])
        )
    return None  # generic price lists, help, greeting, out of scope ...: never spoken
