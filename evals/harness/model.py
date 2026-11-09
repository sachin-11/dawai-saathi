"""Plain data types shared by the harness and the suites."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

OFFLINE = "fake"  # CLI alias: every offline mode a suite declares


@dataclass(frozen=True, slots=True)
class Failure:
    """One failing example. Ids and short redacted snippets only (never a full reply or raw OCR)."""

    case_id: str
    why: str
    snippet: str = ""


class BudgetExceeded(RuntimeError):
    """Real-mode spending passed `EVAL_MAX_USD`; the run is aborted and reported as such."""


@dataclass(slots=True)
class Budget:
    max_usd: float | None
    spent: float = 0.0

    def add(self, usd: float) -> None:
        self.spent += max(usd, 0.0)
        if self.max_usd is not None and self.spent > self.max_usd:
            raise BudgetExceeded(f"eval cost cap exceeded: ${self.spent:.4f} > ${self.max_usd:.2f}")


@dataclass(slots=True)
class RunContext:
    mode: str
    limit: int | None = None
    seed: int = 1234
    concurrency: int = 1
    budget: Budget = field(default_factory=lambda: Budget(None))
    language: str = "en"

    @property
    def is_real(self) -> bool:
        return self.mode == "real"


@dataclass(slots=True)
class SuiteResult:
    suite: str
    mode: str
    metrics: dict[str, float]
    cases: int = 0
    failures: list[Failure] = field(default_factory=list)
    detail_md: str = ""
    cost_usd: float = 0.0
    latencies_ms: list[float] = field(default_factory=list)
    prompt_versions: list[str] = field(default_factory=list)
    models: dict[str, str] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    aborted: str | None = None  # e.g. budget exceeded / unavailable


SuiteFn = Callable[[RunContext], Awaitable[SuiteResult]]


@dataclass(frozen=True, slots=True)
class Suite:
    name: str
    description: str
    run: SuiteFn
    offline_modes: tuple[str, ...]
    real_mode: bool = False
    dataset: Path | None = None  # file or directory hashed into the report
    est_real_cost_usd: float = 0.0
    needs: tuple[str, ...] = ()  # generators / services this suite needs, shown in errors

    def supports(self, mode: str) -> bool:
        return mode in self.offline_modes or (mode == "real" and self.real_mode)


def jsonable(value: Any) -> Any:
    """Make metrics/results JSON-safe (floats rounded so reports and baselines diff cleanly)."""
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value
