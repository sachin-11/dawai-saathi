"""Price of speech calls, from `pricing.yaml` (`stt_models` per audio minute, `tts_models` per 1k
characters, US dollars). Unknown model = 0 and a one-time warning, exactly like LLM pricing."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog
import yaml

from app.llm.pricing import DEFAULT_PRICING_PATH

_log = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class AudioPrice:
    per_unit_usd: float
    placeholder: bool


class AudioPricing:
    def __init__(self, stt: dict[str, AudioPrice], tts: dict[str, AudioPrice]) -> None:
        self._stt = stt
        self._tts = tts
        self._warned: set[tuple[str, str]] = set()

    @classmethod
    def load(cls, path: Path = DEFAULT_PRICING_PATH) -> "AudioPricing":
        raw: Any = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

        def table(key: str, field: str) -> dict[str, AudioPrice]:
            section = raw.get(key) or {}
            return {
                str(model): AudioPrice(float(entry[field]), bool(entry.get("placeholder", False)))
                for model, entry in section.items()
            }

        return cls(table("stt_models", "per_minute_usd"), table("tts_models", "per_1k_chars_usd"))

    def _warn_once(self, kind: str, model: str) -> None:
        if (kind, model) not in self._warned:
            self._warned.add((kind, model))
            _log.warning("pricing_missing", model=model, kind=kind)

    def stt_cost_usd(self, model: str, duration_s: float) -> float:
        price = self._stt.get(model)
        if price is None:
            self._warn_once("stt", model)
            return 0.0
        return price.per_unit_usd * duration_s / 60.0

    def tts_cost_usd(self, model: str, characters: int) -> float:
        price = self._tts.get(model)
        if price is None:
            self._warn_once("tts", model)
            return 0.0
        return price.per_unit_usd * characters / 1000.0
