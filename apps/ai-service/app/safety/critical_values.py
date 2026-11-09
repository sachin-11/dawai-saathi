"""Critical-value thresholds (M12). The numbers live in `critical_values.yaml` (a doctor must review it)."""

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

CRITICAL_FILE = Path(__file__).with_name("critical_values.yaml")


@dataclass(frozen=True, slots=True)
class CriticalLimits:
    low: float | None = None
    high: float | None = None


CriticalValues = dict[str, CriticalLimits]


@lru_cache(maxsize=1)
def load_critical_values() -> CriticalValues:
    loaded = yaml.safe_load(CRITICAL_FILE.read_text(encoding="utf-8"))
    values: CriticalValues = {}
    for code, limits in loaded["values"].items():
        low = limits.get("low")
        high = limits.get("high")
        values[str(code)] = CriticalLimits(
            None if low is None else float(low), None if high is None else float(high)
        )
    return values


def critical_status(code: str, canonical_value: float) -> str | None:
    """`critical_low` / `critical_high` when the value is strictly beyond a limit, else None."""
    limits = load_critical_values().get(code)
    if limits is None:
        return None
    if limits.low is not None and canonical_value < limits.low:
        return "critical_low"
    if limits.high is not None and canonical_value > limits.high:
        return "critical_high"
    return None
