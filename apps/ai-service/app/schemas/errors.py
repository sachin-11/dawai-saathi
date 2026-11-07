"""Error body shared with the gateway: {"error": {status, code, message, details?, request_id}}."""

from http import HTTPStatus

from pydantic import BaseModel, ConfigDict


class ErrorDetail(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: int
    code: str
    message: str
    details: list[str] | None = None
    request_id: str


class ErrorResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    error: ErrorDetail


def status_code_name(status: int) -> str:
    try:
        return HTTPStatus(status).name
    except ValueError:
        return "ERROR"


def error_body(
    status: int,
    message: str,
    request_id: str,
    details: list[str] | None = None,
    code: str | None = None,
) -> ErrorResponse:
    return ErrorResponse(
        error=ErrorDetail(
            status=status,
            code=code or status_code_name(status),
            message=message,
            details=details,
            request_id=request_id,
        )
    )
