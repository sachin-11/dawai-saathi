"""Command detection in a voice transcript (M13, CLAUDE.md §7.5/§7.6).

The alias table is the SAME file the gateway reads (`packages/contracts/commands/aliases.json`,
copied by `make safety-data`). Matching is on the WHOLE normalised utterance, never a substring, so
"mujhe apni dawai ke baare me poochna hai" is a question, not MEDS. A voice transcript is noisier than
typed text, so a small list of polite fillers ("please", "ji") is dropped first.

Safety rules that live here:
  * DELETE is only DETECTED. The gateway still asks for the button confirmation: nothing is ever
    deleted on a transcript alone.
  * caregiver commands are never returned for voice (they need a number / a name: type them).
  * bare yes/no words ("haan", "nahi") are not reminder acks by voice: the gateway answers an ack
    only while a reminder is open, but a stray "haan" in a conversation must not mark a dose as taken.
"""

import json
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Final

from app.schemas.process import Command

ALIASES_PATH: Final = Path(__file__).parent / "data" / "command-aliases.json"

_NUKTA: Final = "़"
_CANDRABINDU: Final = "ँ"
_ANUSVARA: Final = "ं"


def normalise_for_matching(text: str) -> str:
    """Same function as the gateway's `normaliseForMatching` (lower-case, nukta/candrabindu folded,
    invisible characters dropped, non letters/numbers/marks become spaces, whitespace collapsed)."""
    folded = unicodedata.normalize("NFD", text).lower()
    kept: list[str] = []
    for char in folded:
        if unicodedata.category(char) == "Cf" or char == _NUKTA:
            continue
        kept.append(_ANUSVARA if char == _CANDRABINDU else char)
    composed = unicodedata.normalize("NFC", "".join(kept))
    cleaned = "".join(
        char if char.isspace() or unicodedata.category(char)[0] in {"L", "N", "M"} else " "
        for char in composed
    )
    return " ".join(cleaned.split())


class CommandTable:
    def __init__(self, data: dict[str, object]) -> None:
        self.version = str(data["version"])
        commands = data["commands"]
        acks = data["acks"]
        if not isinstance(commands, dict) or not isinstance(acks, dict):
            raise ValueError("command aliases: 'commands' and 'acks' must be objects")
        allowed = {str(c) for c in data["voice_commands"]}  # type: ignore[attr-defined]
        text_only = {normalise_for_matching(str(a)) for a in data["ack_text_only"]}  # type: ignore[attr-defined]
        self._fillers = frozenset(
            normalise_for_matching(str(f))
            for f in data["voice_fillers"]  # type: ignore[attr-defined]
        )
        self._lookup: dict[str, Command] = {}
        for name, aliases in commands.items():
            if name not in allowed:
                continue
            for alias in aliases:
                self._lookup[normalise_for_matching(alias)] = Command(name)
        ack_commands = {
            "taken": Command.reminder_taken,
            "snooze": Command.reminder_snooze,
            "skip": Command.reminder_skip,
        }
        for kind, aliases in acks.items():
            for alias in aliases:
                key = normalise_for_matching(alias)
                if key not in text_only and key not in self._lookup:
                    self._lookup[key] = ack_commands[kind]

    def _without_fillers(self, normalised: str) -> str:
        words = [w for w in normalised.split(" ") if w not in self._fillers]
        return " ".join(words)

    def detect(self, *transcripts: str | None) -> Command | None:
        """The command the WHOLE utterance means, or None. Each transcript (original script,
        Roman copy) is tried; the first match wins."""
        for text in transcripts:
            if not text:
                continue
            normalised = normalise_for_matching(text)
            if not normalised:
                continue
            for candidate in (normalised, self._without_fillers(normalised)):
                found = self._lookup.get(candidate)
                if found is not None:
                    return found
        return None


@lru_cache(maxsize=1)
def load_command_table() -> CommandTable:
    return CommandTable(json.loads(ALIASES_PATH.read_text(encoding="utf-8")))
