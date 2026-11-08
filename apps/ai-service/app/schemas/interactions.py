"""Interaction-check payloads (M11). Part of the `/v1/process` contract.

Every value is produced by deterministic code from `interactions` rows and the medicines' salt keys;
the language model never states an interaction fact (CLAUDE.md §2.5).
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Severity = Literal["minor", "moderate", "major"]
FindingType = Literal["interaction", "duplicate_ingredient"]
# Wording class of a finding: severity for pairs, and two kinds of duplicate ingredient.
ManagementKey = Literal["major", "moderate", "minor", "duplicate", "duplicate_overdose"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InteractionFinding(_Model):
    type: FindingType
    # None for a duplicate ingredient: the same salt twice is not a pair with a severity.
    severity: Severity | None = None
    # Canonical salt keys, salt_a <= salt_b (equal for a duplicate ingredient).
    salt_a: str = Field(max_length=200)
    salt_b: str = Field(max_length=200)
    # Which medicines are involved: "rx:<index>" = the index in the new prescription's medicines
    # (or the typed names of a question), anything else = the id of a stored medication.
    medication_refs: list[str] = Field(default_factory=list, max_length=20)
    # Display names of the medicines involved (as the user knows them), same order as the refs.
    labels: list[str] = Field(default_factory=list, max_length=20)
    interaction_id: str | None = None
    effect_code: str | None = Field(default=None, max_length=60)
    management_key: ManagementKey
    # True when at least one involved medicine is new (not only stored ones): only those are
    # announced in the reply to a new prescription.
    involves_new: bool = True
    # The row's own fields, for the details view (never a model's words).
    management_en: str | None = Field(default=None, max_length=400)
    management_hi: str | None = Field(default=None, max_length=400)
    hi_reviewed: bool = False
    source_name: str | None = Field(default=None, max_length=200)


class UncheckedMedicine(_Model):
    ref: str
    label: str | None = Field(default=None, max_length=200)


class ResolvedMedicine(_Model):
    """The salt the checker used for one medicine ("rx:<index>" for a new one). The gateway stores it
    on the saved medication when that has no `salt_key` yet, so the NEXT prescription sees it."""

    ref: str
    salt_key: str = Field(max_length=200)


class InteractionReport(_Model):
    findings: list[InteractionFinding] = Field(default_factory=list, max_length=100)
    unchecked: list[UncheckedMedicine] = Field(default_factory=list, max_length=50)
    resolved: list[ResolvedMedicine] = Field(default_factory=list, max_length=50)
    # How many medicines (new + stored) could be looked up. Fewer than 2 = no pair was checked.
    checked_count: int = Field(default=0, ge=0)
    # False when the interaction database could not be read: then NOTHING may be said about safety.
    database_ok: bool = True
