"""`POST /v1/generic-details` contract (M8): the gateway sends what it stored, gets the message back."""

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.catalog import GenericSuggestion
from app.schemas.process import Language, Reply, RequestId


class GenericDetailsItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    strength: str | None = Field(default=None, max_length=50)
    generic: GenericSuggestion | None = None


class GenericDetailsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: RequestId
    language: Language
    # The readable medicines of one prescription, with the suggestion snapshot stored at read time.
    medicines: list[GenericDetailsItem] = Field(min_length=1, max_length=20)


class GenericDetailsResponse(BaseModel):
    request_id: RequestId
    reply: Reply
