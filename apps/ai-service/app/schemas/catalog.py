"""Catalog match and generic-suggestion payloads (M8). Part of the `/v1/process` contract.

All of it is produced by deterministic code (`drug_matcher`, `generic_finder`); the language model
never decides a salt, a strength or a price (CLAUDE.md §2.5).
"""

from datetime import date
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class MatchMethod(StrEnum):
    exact = "exact"
    trgm = "trgm"
    vector = "vector"
    salt_written = "salt_written"
    none = "none"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DrugCandidate(_Model):
    drug_id: str
    brand_name: str = Field(max_length=200)
    score: float = Field(ge=0.0, le=1.0)


class DrugMatch(_Model):
    """What the catalog says about one prescribed medicine."""

    drug_id: str | None = None  # None for `none` and for `salt_written` (no specific product)
    brand_name: str | None = Field(default=None, max_length=200)
    salt_key: str | None = None
    strength_key: str | None = None
    form_key: str | None = None
    release_type: str | None = None
    score: float = Field(default=0.0, ge=0.0, le=1.0)
    method: MatchMethod = MatchMethod.none
    candidates: list[DrugCandidate] = Field(default_factory=list, max_length=3)
    # Where the strength was confirmed from: what the prescription wrote, or the number in the brand
    # name ("Dolo 650"). "none" means unverified: a generic is never suggested then.
    strength_basis: Literal["prescription", "brand_name", "none"] = "none"
    strength_conflict: bool = (
        False  # the prescription's strength differs from the matched product's
    )
    form_conflict: bool = False
    ambiguous: bool = False  # two products of different strength fit equally well
    note: str | None = Field(default=None, max_length=60)


NoGenericReason = Literal[
    "low_confidence",
    "no_match",
    "weak_match",
    "strength_mismatch",
    "form_mismatch",
    "strength_unverified",
    "ambiguous",
    "not_substitutable",
    "no_exact_alternative",
    "no_cheaper_option",
]


class GenericAlternative(_Model):
    drug_id: str
    brand_name: str = Field(max_length=200)
    is_janaushadhi: bool
    price_per_unit: float = Field(ge=0)
    pack_label: str | None = Field(default=None, max_length=40)  # e.g. "10 tablet"
    pack_price: float | None = Field(default=None, ge=0)  # MRP of that pack
    approx_savings: int | None = Field(
        default=None, ge=0
    )  # rupees; None when the brand price is unknown
    savings_basis: Literal["course", "pack"] | None = None


class GenericSuggestion(_Model):
    alternatives: list[GenericAlternative] = Field(default_factory=list, max_length=2)
    reason_if_none: NoGenericReason | None = None
    price_source_date: date | None = None  # oldest price date used: shown to the user
    # True when at least one alternative carries a saving (both prices known and comparable).
    savings_known: bool = False
