"""One object the pipeline talks to for interaction work (M11): build the inputs, run the check."""

import re
import time
from collections.abc import Sequence

import structlog
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.catalog.normalise import split_salts
from app.config import Settings
from app.interactions.repository import InteractionRepository, PgInteractionRepository
from app.schemas.catalog import DrugMatch
from app.schemas.interactions import InteractionReport, ResolvedMedicine
from app.schemas.prescription import PrescriptionExtraction
from app.schemas.process import ActiveMedication
from app.tools.interaction_check import (
    NEW_REF_PREFIX,
    CheckedMedication,
    check_interactions,
    salt_is_certain,
)
from app.tools.rx_gate import unclear_fields

log = structlog.get_logger("interaction_service")

_KNOWN_SALTS_TTL_S = 600.0
_FORM_PREFIX = re.compile(r"^(?:tab|tablet|cap|capsule|inj|injection|syp|syrup)\.?\s+", re.I)
_NUMBERS = re.compile(r"\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)?", re.I)


def salt_from_name(name: str | None, known: frozenset[str]) -> str | None:
    """A medicine written by its salt name ("Warfarin", "Tab. Ibuprofen + Paracetamol") resolves to a
    salt key even when no catalog product has it. ALL components must be salts the interaction table
    knows by their canonical name; a brand name ("Brufen") or anything unclear returns None."""
    if not name or not known:
        return None
    text = _NUMBERS.sub(" ", _FORM_PREFIX.sub("", name.strip()))
    salts = split_salts(text)
    if not salts or any(salt not in known for salt in salts):
        return None
    return "+".join(sorted(salts))


def stored_medications(active: Sequence[ActiveMedication]) -> list[CheckedMedication]:
    """The user's stored medicines (from ALL their prescriptions) as checker input.

    Only a stored `salt_key` is trusted: the gateway keeps it only for a certain match, so a
    medicine without one is reported as "could not be checked", never guessed from the free-text salt.
    """
    result: list[CheckedMedication] = []
    for index, medication in enumerate(active):
        result.append(
            CheckedMedication(
                ref=medication.medication_id or f"ctx:{index}",
                label=medication.name or medication.salt,
                salt_key=medication.salt_key or None,
                is_new=False,
            )
        )
    return result


def _salt_for(
    match: DrugMatch | None, name: str | None, match_min: float, known: frozenset[str]
) -> str | None:
    if match is not None and salt_is_certain(match, match_min, name):
        return match.salt_key
    return salt_from_name(name, known)


def prescription_medications(
    extraction: PrescriptionExtraction,
    matches: Sequence[DrugMatch | None],
    *,
    min_confidence: float,
    match_min: float,
    known_salts: frozenset[str] = frozenset(),
) -> list[CheckedMedication]:
    """The new prescription's medicines. A medicine that could not be read is left out here: the
    reply already says so, and a guess must not enter a safety check."""
    result: list[CheckedMedication] = []
    for index, medicine in enumerate(extraction.medicines):
        if medicine.low_confidence or unclear_fields(medicine, min_confidence):
            continue
        match = matches[index] if index < len(matches) else None
        result.append(
            CheckedMedication(
                ref=f"{NEW_REF_PREFIX}{index}",
                label=medicine.name.value,
                salt_key=_salt_for(match, medicine.name.value, match_min, known_salts),
                is_new=True,
            )
        )
    return result


def typed_medications(
    names: Sequence[str],
    matches: Sequence[DrugMatch | None],
    *,
    match_min: float,
    known_salts: frozenset[str] = frozenset(),
) -> list[CheckedMedication]:
    """Medicines named in a question ("Dolo aur Combiflam saath le sakte hain?")."""
    result: list[CheckedMedication] = []
    for index, name in enumerate(names):
        match = matches[index] if index < len(matches) else None
        result.append(
            CheckedMedication(
                ref=f"{NEW_REF_PREFIX}{index}",
                label=name,
                salt_key=_salt_for(match, name, match_min, known_salts),
                is_new=True,
            )
        )
    return result


class InteractionService:
    def __init__(self, repo: InteractionRepository, *, match_min: float = 0.8) -> None:
        self.repo = repo
        self.match_min = match_min
        self._known: frozenset[str] = frozenset()
        self._known_at = float("-inf")

    @classmethod
    def from_settings(
        cls, settings: Settings, sessions: async_sessionmaker[AsyncSession]
    ) -> "InteractionService":
        return cls(PgInteractionRepository(sessions), match_min=settings.drug_match_min)

    async def known_salts(self) -> frozenset[str]:
        """Canonical salt names that have at least one interaction row (cached for a few minutes).
        A database problem returns what we had: the name fallback is then simply not used."""
        if time.monotonic() - self._known_at > _KNOWN_SALTS_TTL_S:
            try:
                self._known = await self.repo.known_salts()
                self._known_at = time.monotonic()
            except Exception as error:
                log.warning("known_salts_failed", error_type=type(error).__name__)
        return self._known

    async def check(
        self, medications: Sequence[CheckedMedication], *, only_new: bool = True
    ) -> InteractionReport:
        """Never raises: `check_interactions` reports a database problem as `database_ok=False`."""
        report = await check_interactions(medications, self.repo, only_new=only_new)
        resolved = [
            ResolvedMedicine(ref=m.ref, salt_key=m.salt_key)
            for m in medications
            if m.is_new and m.salt_key
        ]
        return report.model_copy(update={"resolved": resolved})
