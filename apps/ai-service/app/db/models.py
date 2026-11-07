"""Read models for the shared catalog tables (CLAUDE.md §6).

OWNERSHIP RULE (CLAUDE.md §4): the AI service is stateless and READ-ONLY. It may read the catalog
(`drugs`, `interactions`, `lab_tests`) and nothing else — there are deliberately NO models for
users, messages, documents, medications, reminders or caregivers. The database enforces this too:
the service connects as the `dawai_ai_ro` role, which only has SELECT on these three tables, and
every session is opened with `default_transaction_read_only = on`.

The gateway's Prisma schema is the source of truth for the columns; keep these in sync with
`apps/gateway/prisma/schema.prisma`.
"""

import enum
import uuid
from decimal import Decimal

from sqlalchemy import Boolean, Enum, Integer, Numeric, Text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class InteractionSeverity(enum.StrEnum):
    minor = "minor"
    moderate = "moderate"
    major = "major"


class LabSex(enum.StrEnum):
    any = "any"
    m = "m"
    f = "f"


class Base(DeclarativeBase):
    """Declarative base for read models. Never call `create_all`: the gateway owns migrations."""


class Drug(Base):
    __tablename__ = "drugs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    brand_name: Mapped[str] = mapped_column(Text)
    # Normalised: sorted, lowercase salts joined with " + ". Exact-match key for the generic finder.
    salt_composition: Mapped[str] = mapped_column(Text)
    strength: Mapped[str] = mapped_column(Text)
    form: Mapped[str] = mapped_column(Text)
    pack_size: Mapped[str | None] = mapped_column(Text)
    mrp: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    manufacturer: Mapped[str | None] = mapped_column(Text)
    is_generic: Mapped[bool] = mapped_column(Boolean)
    janaushadhi_code: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)


class Interaction(Base):
    __tablename__ = "interactions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # Stored once per pair, canonical order (salt_a < salt_b) — enforced by a CHECK in the DB.
    salt_a: Mapped[str] = mapped_column(Text)
    salt_b: Mapped[str] = mapped_column(Text)
    severity: Mapped[InteractionSeverity] = mapped_column(
        Enum(InteractionSeverity, name="interaction_severity", create_type=False)
    )
    summary: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)


class LabTest(Base):
    __tablename__ = "lab_tests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    code: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    aliases: Mapped[list[str]] = mapped_column(ARRAY(Text))
    unit: Mapped[str] = mapped_column(Text)
    ref_low: Mapped[Decimal | None] = mapped_column(Numeric)
    ref_high: Mapped[Decimal | None] = mapped_column(Numeric)
    sex: Mapped[LabSex] = mapped_column(Enum(LabSex, name="lab_sex", create_type=False))
    age_min: Mapped[int | None] = mapped_column(Integer)
    age_max: Mapped[int | None] = mapped_column(Integer)
    explanation_en: Mapped[str] = mapped_column(Text)
    explanation_hi: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)
