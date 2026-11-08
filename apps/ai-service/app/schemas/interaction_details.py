"""`POST /v1/interaction-details` contract (M11).

The gateway sends what it stored (which salts, which medicine names); the AI service re-reads the
interaction rows from the database and renders the details, so the text always comes from a row and
is never a copy the gateway kept (CLAUDE.md §2.5). No model is called.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.interactions import UncheckedMedicine
from app.schemas.process import Language, Reply, RequestId


class StoredWarning(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["interaction", "duplicate_ingredient"]
    salt_a: str = Field(max_length=200)
    salt_b: str = Field(max_length=200)
    labels: list[str] = Field(default_factory=list, max_length=20)


class InteractionDetailsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: RequestId
    language: Language
    warnings: list[StoredWarning] = Field(default_factory=list, max_length=100)
    unchecked: list[UncheckedMedicine] = Field(default_factory=list, max_length=50)
    checked_count: int = Field(default=0, ge=0)


class InteractionDetailsResponse(BaseModel):
    request_id: RequestId
    reply: Reply
