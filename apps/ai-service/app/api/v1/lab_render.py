"""POST /v1/lab-render: "See all tests" and `REPORTS` (M12). Rendered from the stored extraction only."""

import structlog
from fastapi import APIRouter, Depends, Request

from app.api.auth import require_service_token
from app.config import Settings
from app.labs.service import LabService
from app.schemas.lab_render import LabRenderRequest, LabRenderResponse
from app.schemas.process import Reply
from app.tools.lab_render import render_all_tests, render_lab_reply
from app.tools.lab_verify import lab_failures

router = APIRouter(prefix="/v1", tags=["lab"])
log = structlog.get_logger("lab_render")


@router.post(
    "/lab-render",
    response_model=LabRenderResponse,
    dependencies=[Depends(require_service_token)],
    responses={
        401: {"description": "Missing or wrong X-Service-Token"},
        422: {"description": "Invalid request"},
    },
)
async def lab_render(body: LabRenderRequest, request: Request) -> LabRenderResponse:
    structlog.contextvars.bind_contextvars(request_id=body.request_id)
    settings: Settings = request.app.state.settings
    labs: LabService | None = request.app.state.labs
    index = await labs.index() if labs is not None else None
    minimum = settings.extraction_min_confidence
    if body.mode == "all":
        text = render_all_tests(body.extraction, index, body.language, minimum=minimum)
    else:
        text = render_lab_reply(body.extraction, index, body.language, minimum=minimum)
        if lab_failures(text, body.extraction, index, body.language):
            # same rule as the live reply: a failed check ends in the plain version
            log.warning("lab_render_check_failed")
            text = render_lab_reply(
                body.extraction, index, body.language, minimum=minimum, mode="minimal"
            )
    log.info("lab_render_done", mode=body.mode, results=len(body.extraction.results))
    return LabRenderResponse(
        request_id=body.request_id, reply=Reply(language=body.language, text=text)
    )
