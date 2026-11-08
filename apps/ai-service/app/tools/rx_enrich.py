"""Post-extraction steps shared by every prescription pipeline (moved out of `pipeline/rx.py` in M9).

redact_free_text     PHI minimisation, second line (CLAUDE.md §2.6)
match_medicines      normalize_drugs: catalog match per medicine (M8)
find_generics        generic_finder: suggestions per medicine (M8)
attach_catalog       put match + suggestion on the extraction (discarding whatever a model sent)
"""

from collections.abc import Sequence

from app.catalog.service import CatalogService
from app.safety.redaction import Redactor
from app.schemas.catalog import DrugMatch, GenericSuggestion
from app.schemas.prescription import DateField, Medicine, PrescriptionExtraction, TextField
from app.schemas.process import Warning, WarningType
from app.tools.generic_finder import MedicineFacts
from app.tools.rx_gate import unclear_fields


def redact_free_text(
    extraction: PrescriptionExtraction, redactor: Redactor
) -> PrescriptionExtraction:
    """The schema has no PHI fields; the few free-text fields (the written line, instructions,
    notes) still go through the redactor before anything is stored."""

    def redact(text: str) -> str:
        return redactor.redact(text).text

    medicines = []
    for medicine in extraction.medicines:
        updated = medicine.model_copy(deep=True)
        if updated.raw_text.value:
            updated.raw_text = TextField(
                value=redact(updated.raw_text.value), confidence=updated.raw_text.confidence
            )
        if updated.instructions.value:
            updated.instructions = TextField(
                value=redact(updated.instructions.value), confidence=updated.instructions.confidence
            )
        medicines.append(updated)
    notes = [redact(note) for note in extraction.notes_for_user]
    return extraction.model_copy(update={"medicines": medicines, "notes_for_user": notes})


def facts_for(medicine: Medicine, threshold: float) -> MedicineFacts:
    return MedicineFacts(
        low_confidence=bool(unclear_fields(medicine, threshold)),
        dose=medicine.dose.value,
        frequency_per_day=medicine.frequency_per_day.value,
        duration_days=medicine.duration_days.value,
        as_needed=medicine.as_needed,
    )


def _matchable(medicine: Medicine, threshold: float) -> bool:
    """A medicine whose NAME could not be read is not matched at all (nothing to look up)."""
    return medicine.name.value is not None and "name" not in unclear_fields(medicine, threshold)


async def match_medicines(
    extraction: PrescriptionExtraction, catalog: CatalogService | None, threshold: float
) -> list[DrugMatch | None]:
    """One entry per medicine, aligned with `extraction.medicines`; None = not matched."""
    matches: list[DrugMatch | None] = []
    for medicine in extraction.medicines:
        if catalog is None or not _matchable(medicine, threshold) or medicine.name.value is None:
            matches.append(None)
            continue
        matches.append(
            await catalog.match(medicine.name.value, medicine.strength.value, medicine.form.value)
        )
    return matches


async def find_generics(
    extraction: PrescriptionExtraction,
    matches: Sequence[DrugMatch | None],
    catalog: CatalogService | None,
    threshold: float,
) -> list[GenericSuggestion | None]:
    """One entry per medicine; an unclear dose or frequency gives `low_confidence`, not a suggestion."""
    out: list[GenericSuggestion | None] = []
    for medicine, match in zip(extraction.medicines, matches, strict=True):
        if catalog is None or match is None:
            out.append(None)
            continue
        out.append(await catalog.generic(match, facts_for(medicine, threshold)))
    return out


def attach_catalog(
    extraction: PrescriptionExtraction,
    matches: Sequence[DrugMatch | None],
    generics: Sequence[GenericSuggestion | None],
) -> PrescriptionExtraction:
    """Whatever the model put in `match` / `generic` is discarded: only our code decides these."""
    medicines = [
        medicine.model_copy(update={"match": match, "generic": generic})
        for medicine, match, generic in zip(extraction.medicines, matches, generics, strict=True)
    ]
    return extraction.model_copy(update={"medicines": medicines})


async def enrich_with_catalog(
    extraction: PrescriptionExtraction, catalog: CatalogService | None, threshold: float
) -> PrescriptionExtraction:
    """normalize_drugs + generic_finder in one go (the pre-graph pipeline)."""
    matches = await match_medicines(extraction, catalog, threshold)
    generics = await find_generics(extraction, matches, catalog, threshold)
    return attach_catalog(extraction, matches, generics)


def needs_review_extraction() -> PrescriptionExtraction:
    """The (empty, PHI-free) extraction recorded when the model's answer stayed invalid."""
    return PrescriptionExtraction(
        is_prescription=True,
        image_quality="poor",
        medicines=[],
        prescription_date=DateField(value=None, confidence=0.0),
        overall_confidence=0.0,
        status="needs_review",
    )


NEEDS_REVIEW_WARNING = Warning(
    type=WarningType.low_confidence, detail="prescription could not be read"
)
