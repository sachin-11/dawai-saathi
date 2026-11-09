"""`POST /v1/lab-render` contract (M12): the gateway sends a STORED lab extraction and gets a message back
("See all tests" button, `REPORTS`). Pure rendering, no model call."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.schemas.lab_report import LabReportExtraction
from app.schemas.process import Language, Reply, RequestId


class LabRenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: RequestId
    language: Language
    mode: Literal["summary", "all"]
    extraction: LabReportExtraction


class LabRenderResponse(BaseModel):
    request_id: RequestId
    reply: Reply
