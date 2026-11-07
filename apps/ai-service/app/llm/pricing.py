"""Cost of an LLM call, computed from `pricing.yaml` (US dollars per 1M tokens)."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog
import yaml

DEFAULT_PRICING_PATH = Path(__file__).with_name("pricing.yaml")

_logger = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class ModelPrice:
    input_per_mtok: float
    output_per_mtok: float
    placeholder: bool


class PricingTable:
    def __init__(self, prices: dict[str, ModelPrice], version: str) -> None:
        self._prices = prices
        self.version = version
        self._warned: set[str] = set()

    @classmethod
    def load(cls, path: Path = DEFAULT_PRICING_PATH) -> "PricingTable":
        raw: Any = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("models"), dict):
            raise ValueError("pricing file must contain a `models` mapping")
        prices: dict[str, ModelPrice] = {}
        for model, entry in raw["models"].items():
            prices[str(model)] = ModelPrice(
                input_per_mtok=float(entry["input_per_mtok"]),
                output_per_mtok=float(entry["output_per_mtok"]),
                placeholder=bool(entry.get("placeholder", False)),
            )
        return cls(prices, version=str(raw.get("version", "unknown")))

    def price_of(self, model: str) -> ModelPrice | None:
        return self._prices.get(model)

    def cost_usd(self, model: str, input_tokens: int, output_tokens: int) -> float:
        """Dollar cost of one call. An unknown model costs 0 and is logged ONCE (never fails a request)."""
        price = self._prices.get(model)
        if price is None:
            if model not in self._warned:
                self._warned.add(model)
                _logger.warning("pricing_missing", model=model)
            return 0.0
        return (
            input_tokens * price.input_per_mtok + output_tokens * price.output_per_mtok
        ) / 1_000_000
