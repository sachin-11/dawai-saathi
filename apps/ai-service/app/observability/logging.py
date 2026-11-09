"""Structured JSON logging (structlog), also used for stdlib/uvicorn loggers.

Log levels mirror the gateway (pino names) so one LOG_LEVEL works for both apps.
Never log phone numbers, names, raw OCR text or request bodies (CLAUDE.md §10).
"""

import logging
import sys
from typing import Final

import structlog
from structlog.typing import Processor

from app.config import LogLevel
from app.observability.otel import add_trace_context
from app.safety.redaction import redact_value

SILENT: Final = logging.CRITICAL + 10

_LEVELS: Final[dict[LogLevel, int]] = {
    "fatal": logging.CRITICAL,
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
    "trace": logging.DEBUG,
    "silent": SILENT,
}


# Log fields that may carry user text. Whatever is logged under these names is redacted first.
SENSITIVE_FIELDS: Final = frozenset({"text", "body", "prompt", "output"})


def redact_sensitive_fields(
    _logger: object, _method: str, event_dict: structlog.typing.EventDict
) -> structlog.typing.EventDict:
    """structlog processor: redact the value of any field named text / body / prompt / output."""
    for name in SENSITIVE_FIELDS & event_dict.keys():
        event_dict[name] = redact_value(event_dict[name])
    return event_dict


def configure_logging(
    level: LogLevel, service: str = "ai-service", env: str = "development"
) -> None:
    numeric_level = _LEVELS[level]

    shared: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        add_trace_context,
        redact_sensitive_fields,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        # structlog only knows standard levels; "silent" is enforced by the root level below.
        wrapper_class=structlog.make_filtering_bound_logger(min(numeric_level, logging.CRITICAL)),
        cache_logger_on_first_use=False,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            _add_service(service, env),
            structlog.processors.JSONRenderer(),
        ],
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(numeric_level)

    # uvicorn installs its own handlers; route them through ours instead.
    for name in ("uvicorn", "uvicorn.error"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers = []
        uv_logger.propagate = True
    # Access logs are replaced by our request middleware (adds request_id, drops query strings).
    logging.getLogger("uvicorn.access").disabled = True


def _add_service(service: str, env: str) -> Processor:
    def processor(
        _logger: object, _method: str, event_dict: structlog.typing.EventDict
    ) -> structlog.typing.EventDict:
        event_dict.setdefault("service", service)
        event_dict.setdefault("env", env)
        return event_dict

    return processor
