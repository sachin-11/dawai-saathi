"""The confidence gate (M7, CLAUDE.md §2.3): decide what may be shown as readable.

A medicine is `low_confidence` when its NAME, DOSE or FREQUENCY is missing or below
`EXTRACTION_MIN_CONFIDENCE`. Such a medicine is still listed (the user must know it exists) but the
reply says it could not be read clearly and asks for a pharmacist's confirmation; it is never saved
as active, and never used for reminders or interaction checks.

Document status:
  done          every medicine is confident
  needs_review  at least one medicine is low confidence (and at least one is readable)
  failed        not a prescription, unreadable, or no medicine with a readable name
"""

from dataclasses import dataclass

from app.schemas.prescription import Medicine, PrescriptionExtraction
from app.schemas.process import Warning, WarningType
from app.tools.rx_validate import effective_frequency_confidence


@dataclass(frozen=True, slots=True)
class GateResult:
    extraction: PrescriptionExtraction  # `status` and every medicine's `low_confidence` are set
    warnings: list[Warning]
    # Machine token for why a document failed (drives the reply template); None unless `failed`.
    failure: str | None = None


def unclear_fields(medicine: Medicine, min_confidence: float) -> list[str]:
    """Which critical fields are missing or too uncertain: `name`, `dose`, `frequency`."""
    unclear: list[str] = []
    if medicine.name.value is None or medicine.name.confidence < min_confidence:
        unclear.append("name")
    if medicine.dose.value is None or medicine.dose.confidence < min_confidence:
        unclear.append("dose")
    # As-needed (SOS) medicines have no daily count: only the written code has to be clear.
    if effective_frequency_confidence(medicine) < min_confidence:
        unclear.append("frequency")
    return unclear


def apply_gate(extraction: PrescriptionExtraction, min_confidence: float) -> GateResult:
    medicines: list[Medicine] = []
    warnings: list[Warning] = []
    for number, medicine in enumerate(extraction.medicines, start=1):
        unclear = unclear_fields(medicine, min_confidence)
        flagged = medicine.model_copy(update={"low_confidence": bool(unclear)})
        medicines.append(flagged)
        if unclear:
            # Index and field names only: never text from the prescription.
            warnings.append(
                Warning(
                    type=WarningType.low_confidence,
                    detail=f"medicine {number}: {', '.join(unclear)} not clear",
                )
            )

    def finish(status: str, failure: str | None = None) -> GateResult:
        gated = extraction.model_copy(update={"medicines": medicines, "status": status})
        return GateResult(extraction=gated, warnings=warnings, failure=failure)

    if not extraction.is_prescription:
        return finish("failed", "not_a_prescription")
    if extraction.image_quality == "unreadable":
        return finish("failed", "unreadable")
    readable = [
        m for m in medicines if m.name.value is not None and m.name.confidence >= min_confidence
    ]
    if not readable:
        return finish("failed", "no_readable_medicine")
    if any(m.low_confidence for m in medicines):
        return finish("needs_review")
    return finish("done")
