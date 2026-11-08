"""POST /v1/generic-details: the "Generic medicines" button (M8). Pure rendering, no model call."""

import structlog
from fastapi import APIRouter, Depends

from app.api.auth import require_service_token
from app.schemas.generic_details import GenericDetailsRequest, GenericDetailsResponse
from app.schemas.process import Reply
from app.tools.generic_render import DetailItem, render_generic_reply

router = APIRouter(prefix="/v1", tags=["generic"])
log = structlog.get_logger("generic_details")


@router.post(
    "/generic-details",
    response_model=GenericDetailsResponse,
    dependencies=[Depends(require_service_token)],
    responses={
        401: {"description": "Missing or wrong X-Service-Token"},
        422: {"description": "Invalid request"},
    },
)
async def generic_details(body: GenericDetailsRequest) -> GenericDetailsResponse:
    """The details message for a saved prescription, from the stored (structured) suggestions only."""
    structlog.contextvars.bind_contextvars(request_id=body.request_id)
    items = [
        DetailItem(number, item.name, item.strength, item.generic)
        for number, item in enumerate(body.medicines, start=1)
    ]
    text = render_generic_reply(items, body.language)
    log.info("generic_details_done", medicines=len(items))  # counts only
    return GenericDetailsResponse(
        request_id=body.request_id, reply=Reply(language=body.language, text=text)
    )
