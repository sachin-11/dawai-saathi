"""Loader and check for `no_substitute.yaml` (M8). A medicine that matches is never offered a generic."""

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

POLICY_PATH = Path(__file__).with_name("no_substitute.yaml")


@dataclass(frozen=True, slots=True)
class NoSubstitutePolicy:
    version: str
    nti_salts: tuple[str, ...]
    biologic_words: tuple[str, ...]
    release_types: frozenset[str]
    forms: frozenset[str]

    def reason(self, *, salt_key: str, form_key: str, release_type: str) -> str | None:
        """None when a generic MAY be suggested, else a short machine token saying why not."""
        salts = [s for s in salt_key.split("+") if s]
        words = " ".join(salts)
        if any(salt.startswith(prefix) for salt in salts for prefix in self.nti_salts):
            return "narrow_therapeutic_index"
        if any(word in words for word in self.biologic_words) or any(
            re.search(r"mab\b", salt) for salt in salts
        ):
            return "biologic_or_insulin"
        if release_type not in self.release_types:
            return "modified_or_delayed_release"
        if form_key not in self.forms:
            return "form_not_substitutable"
        return None


@lru_cache(maxsize=1)
def load_policy(path: Path = POLICY_PATH) -> NoSubstitutePolicy:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return NoSubstitutePolicy(
        version=str(raw["version"]),
        nti_salts=tuple(str(s).lower() for s in raw["narrow_therapeutic_index_salts"]),
        biologic_words=tuple(str(s).lower() for s in raw["biologic_or_insulin_words"]),
        release_types=frozenset(raw["substitutable_release_types"]),
        forms=frozenset(raw["substitutable_forms"]),
    )
