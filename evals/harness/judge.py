"""LLM-as-judge for READABILITY and TONE only (M14 §7). Soft metric, never a gate on safety.

Why so limited: whether a reply is safe or right is decided by deterministic checks (blocklists, grounding,
critical-value rules, fixed templates). A model judge is noisy, can be talked into a score, and shares
blind spots with the model it grades; it is useful only for the question rules cannot answer: "is this
easy for a tired 60-year-old to read?".

Two judges share one interface:
  StubJudge   deterministic heuristics (sentence length, long words, shouting, jargon). Used offline, so the
              plumbing, the report and the validation maths run in CI without a key.
  ModelJudge  `judge_readability_v1` on TEXT_MODEL through the normal LLM router.
"""

import re
import statistics
from dataclasses import dataclass
from typing import Any, Protocol

from pydantic import BaseModel, Field

from app.llm.router import Deadline, LLMRouter
from app.llm.types import Message
from app.prompts.registry import PromptRegistry

JUDGE_PROMPT_ID = "judge_readability_v1"


class ReadabilityScore(BaseModel):
    score: int = Field(ge=1, le=5)
    reason: str = Field(default="", max_length=300)


class Judge(Protocol):
    name: str

    async def score(self, reply: str) -> int: ...


_JARGON = re.compile(
    r"pursuant|aforementioned|concomitant|morphology|repletion|hypochromic|microcytic|correlate|"
    r"schema|token|0x[0-9a-f]+|परामर्श अपेक्षित|निम्न|संदर्भ मान|चिकित्सक|physician|indices|ferritin",
    re.IGNORECASE,
)


class StubJudge:
    """Deterministic stand-in. NOT a quality measure: it exists so the harness can be tested offline."""

    name = "stub-heuristic"

    async def score(self, reply: str) -> int:
        sentences = [s for s in re.split(r"[.!?।\n]+", reply) if s.strip()] or [reply]
        words = reply.split()
        average = len(words) / max(len(sentences), 1)
        long_words = sum(1 for w in words if len(w) > 11) / max(len(words), 1)
        letters = [c for c in reply if c.isalpha()]
        shouting = sum(c.isupper() for c in letters) / max(len(letters), 1)
        points = 5.0
        points -= max(0.0, (average - 14) / 8)
        points -= min(2.0, long_words * 12)
        points -= 2.0 if shouting > 0.5 and len(letters) > 20 else 0.0
        points -= 1.5 if _JARGON.search(reply) else 0.0
        points -= 1.0 if reply.count("!") >= 3 else 0.0
        return max(1, min(5, round(points)))


@dataclass(slots=True)
class ModelJudge:
    router: LLMRouter
    prompts: PromptRegistry
    deadline_s: float = 60.0
    name: str = "model"
    cost_usd: float = 0.0
    errors: int = 0

    async def score(self, reply: str) -> int:
        prompt = self.prompts.load(JUDGE_PROMPT_ID)
        messages = [prompt.to_message(), Message("user", f"<reply>\n{reply}\n</reply>")]
        try:
            result = await self.router.generate(
                prompt.model_role,
                messages,
                name="judge_readability",
                temperature=prompt.temperature,
                max_tokens=150,
                response_model=ReadabilityScore,
                prompt_version=prompt.version,
                deadline=Deadline(self.deadline_s),
            )
        except Exception:  # an outage is counted, never hidden, and never decides anything
            self.errors += 1
            return 0
        self.cost_usd += result.cost_usd
        parsed: Any = result.parsed
        return int(parsed.score) if isinstance(parsed, ReadabilityScore) else 0


@dataclass(frozen=True, slots=True)
class Agreement:
    exact: float
    within_one: float
    mean_abs_error: float
    n: int


def compare(a: list[int], b: list[int]) -> Agreement:
    """Agreement of two score lists (judge vs human, or judge run 1 vs run 2). Zero scores are errors."""
    pairs = [(x, y) for x, y in zip(a, b, strict=True) if x > 0 and y > 0]
    if not pairs:
        return Agreement(0.0, 0.0, 0.0, 0)
    n = len(pairs)
    return Agreement(
        exact=sum(x == y for x, y in pairs) / n,
        within_one=sum(abs(x - y) <= 1 for x, y in pairs) / n,
        mean_abs_error=statistics.fmean(abs(x - y) for x, y in pairs),
        n=n,
    )
