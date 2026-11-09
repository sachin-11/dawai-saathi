"""Economy mode (M15): the same router, but calls that asked for the TEXT model use the CHEAP one.

Vision calls keep their model (a prescription cannot be read by a text model). Everything else is
delegated unchanged, so retries, fallback and circuit breakers behave as before.
"""

from typing import Any

from app.llm.router import LLMRouter
from app.llm.types import LLMResult, ModelRole


class EconomyRouter:
    def __init__(self, inner: LLMRouter) -> None:
        self._inner = inner

    async def generate(self, role: ModelRole, *args: Any, **kwargs: Any) -> LLMResult:
        return await self._inner.generate("cheap" if role == "text" else role, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)
