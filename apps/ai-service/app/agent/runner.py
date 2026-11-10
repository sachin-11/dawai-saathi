"""The Q&A agent runner: emergency rules first, then the agent picks tools, then the reply is assembled.

    question -> emergency rules (no model) -> backend (model picks read-only tools, max MAX_CALLS)
             -> reply = [optional safe lead-in] + tool texts (templates) + disclaimer

Where the model can influence the answer: WHICH tools run and ONE checked lead-in sentence. It cannot
add a fact, because the facts are the tool texts. With no tool call there is a fixed "tell me a name" reply.
"""

from dataclasses import dataclass, field
from typing import Protocol

import structlog

from app.agent.guard import lead_in_is_safe
from app.agent.tools import MAX_CALLS, QATools, ToolResult
from app.prompts.registry import TemplateStore
from app.safety.disclaimers import add_disclaimer
from app.safety.emergency_guard import EmergencyGuard, UserText
from app.schemas.process import Language

log = structlog.get_logger("qa_agent")

MAX_QUESTION_CHARS = 500
NEED_NAME: dict[Language, str] = {
    Language.en: (
        "Tell me a medicine name, two medicines to check together, "
        "or a lab test name (for example “HbA1c”)."
    ),
    Language.hi: "कृपया दवा का नाम, साथ में लेने वाली दो दवाएँ, या लैब टेस्ट का नाम बताइए (जैसे “HbA1c”)।",
}


class AgentBackend(Protocol):
    """The model-driven part. It may only call methods of `tools` and return a short lead-in (or '')."""

    async def run(self, question: str, tools: QATools, language: Language) -> str: ...


@dataclass(frozen=True, slots=True)
class AgentAnswer:
    text: str
    emergency: bool = False
    tools_called: list[str] = field(default_factory=list)
    lead_in_used: bool = False


class QAAgent:
    def __init__(
        self, backend: AgentBackend, guard: EmergencyGuard, templates: TemplateStore
    ) -> None:
        self.backend = backend
        self.guard = guard
        self.templates = templates

    async def answer(self, question: str, tools: QATools, language: Language) -> AgentAnswer:
        question = (question or "").strip()[:MAX_QUESTION_CHARS]
        verdict = self.guard.check_rules(UserText(question))
        if verdict.is_emergency:  # BEFORE any model: CLAUDE.md §2.2
            key = "emergency.self_harm" if verdict.kind == "self_harm" else "emergency.general"
            return AgentAnswer(text=self.templates.get(language, key), emergency=True)
        if not question:
            return AgentAnswer(text=add_disclaimer(NEED_NAME[language], language))

        try:
            lead = await self.backend.run(question, tools, language)
        except Exception as error:  # a model/provider failure must not become a made-up answer
            log.warning("qa_agent_backend_failed", error_type=type(error).__name__)
            lead = ""
        results: list[ToolResult] = [r for r in tools.calls if r.text]
        if not results:
            return AgentAnswer(text=add_disclaimer(NEED_NAME[language], language))

        parts: list[str] = []
        used = False
        if lead and lead_in_is_safe(lead, results):
            parts.append(lead.strip())
            used = True
        parts.extend(r.text for r in results)
        text = add_disclaimer("\n\n".join(parts), language)
        return AgentAnswer(
            text=text, tools_called=[r.tool for r in tools.calls][:MAX_CALLS], lead_in_used=used
        )
