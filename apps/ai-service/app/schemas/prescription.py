"""Prescription extraction schemas (M7, CLAUDE.md §8.2 `PrescriptionExtraction`).

Design rules:
  * Every value carries its own confidence (`Field`): "null with low confidence" is a valid, honest
    answer, a guess is not (CLAUDE.md §2.3).
  * PHI minimisation (§2.6): there is deliberately NO field for patient name, doctor name, phone,
    address, registration number or hospital. The prompt tells the model to ignore them, and the
    schema forbids extra keys, so even a misbehaving model cannot smuggle them into our data.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic import Field as PydField

from app.schemas.catalog import DrugMatch, GenericSuggestion

MAX_MEDICINES = 20
MAX_NOTES = 5

MedicineForm = Literal[
    "tablet", "capsule", "syrup", "injection", "drops", "cream", "inhaler", "powder", "other"
]
Timing = Literal["morning", "afternoon", "evening", "night"]
FoodRelation = Literal["before", "after", "with", "any"]


class _Model(BaseModel):
    # `forbid` is part of the PHI design: an unexpected key (e.g. "patient_name") fails validation.
    model_config = ConfigDict(extra="forbid")


class Field[T](_Model):
    """A value plus how sure we are about it (0..1). `value=None` means "not written / unreadable"."""

    value: T | None = None
    confidence: float = PydField(default=0.0, ge=0.0, le=1.0)


# Concrete field types. They exist so the OpenAPI contract (and the generated TypeScript) gets
# readable names (`TextField`, `IntField`, ...) instead of `Field[Literal['tablet', ...]]`.
class TextField(Field[str]): ...


class IntField(Field[int]): ...


class DateField(Field[date]): ...


class FormField(Field[MedicineForm]): ...


class FoodField(Field[FoodRelation]): ...


class TimingsField(Field[list[Timing]]): ...


class Medicine(_Model):
    raw_text: TextField  # exactly as written, e.g. "Tab. Dolo 650"
    name: TextField  # cleaned brand/generic name, e.g. "Dolo 650"
    form: FormField
    strength: TextField  # "650 mg", null if not written
    dose: TextField  # "1 tablet", "5 ml", "2 puffs"
    frequency_code: TextField  # as written: "1-0-1", "BD", "TDS", "SOS", "HS"
    frequency_per_day: IntField  # derived; null for SOS / as needed
    timings: TimingsField
    relation_to_food: FoodField
    duration_days: IntField  # "x 5 days" -> 5, "1 week" -> 7, "continue" -> null
    as_needed: bool = False  # SOS / PRN
    instructions: TextField  # other written instructions, short
    # Set by OUR validators, never by the model (a model-supplied value is overwritten).
    low_confidence: bool = False
    validation_notes: list[str] = PydField(default_factory=list, max_length=10)
    # M8: catalog match and generic suggestion, set by deterministic code (a model value is overwritten).
    match: DrugMatch | None = None
    generic: GenericSuggestion | None = None


class PrescriptionExtraction(_Model):
    kind: Literal["prescription"] = "prescription"
    is_prescription: bool
    image_quality: Literal["good", "poor", "unreadable"]
    medicines: list[Medicine] = PydField(default_factory=list, max_length=MAX_MEDICINES)
    prescription_date: DateField
    overall_confidence: float = PydField(default=0.0, ge=0.0, le=1.0)
    notes_for_user: list[str] = PydField(default_factory=list, max_length=MAX_NOTES)
    # Set by the confidence gate (not the model): the gateway stores it as `documents.status`.
    status: Literal["done", "needs_review", "failed"] = "done"
