"""Shared helpers for the prescription (M7) tests: synthetic images, a fake fetcher, extraction builders."""

import io
from collections.abc import Awaitable, Callable
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from app.config import Settings
from app.llm.factory import build_llm_router
from app.llm.fake import FakeProvider
from app.llm.router import Deadline
from app.media.fetcher import FetchedMedia
from app.pipeline.base import PipelineContext, RequestUsage
from app.prompts.registry import PromptRegistry, TemplateStore
from app.safety.emergency_guard import EmergencyGuard
from app.safety.redaction import Redactor
from app.schemas.process import ProcessRequest
from tests.conftest import make_settings

LINES = [
    "Dr. Test Doctor  Reg 12345",
    "Rx",
    "1. Tab. Dolo 650   1-0-1   x 5 days  (after food)",
    "2. Tab. Pantop 40  1-0-0   AC  x 10 days",
    "3. Syp. Cough Relief 5 ml  TDS  x 3 days",
]


def sample_jpeg(
    lines: list[str] | None = None, size: tuple[int, int] = (1200, 1600), exif: bytes | None = None
) -> bytes:
    """A sharp, high-contrast 'page of text': passes the quality check."""
    image = Image.new("RGB", size, (250, 250, 245))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=34)
    y = 80
    for line in lines or LINES:
        draw.text((60, y), line, fill=(15, 15, 40), font=font)
        y += 90
    buffer = io.BytesIO()
    kwargs: dict[str, Any] = {"quality": 90}
    if exif is not None:
        kwargs["exif"] = exif
    image.save(buffer, format="JPEG", **kwargs)
    return buffer.getvalue()


FetchFn = Callable[..., Awaitable[FetchedMedia]]


def fake_fetch(data: bytes, mime: str) -> FetchFn:
    async def fetch(*_args: Any, **_kwargs: Any) -> FetchedMedia:
        return FetchedMedia(data=data, mime=mime)

    return fetch


def f(value: Any, confidence: float = 0.95) -> dict[str, Any]:
    return {"value": value, "confidence": confidence}


def medicine(**overrides: Any) -> dict[str, Any]:
    """A clear 'Tab. Dolo 650 1-0-1 x 5 days after food' medicine; override any key."""
    base: dict[str, Any] = {
        "raw_text": f("Tab. Dolo 650 1-0-1 x 5 days"),
        "name": f("Dolo 650"),
        "form": f("tablet"),
        "strength": f("650 mg", 0.8),
        "dose": f("1 tablet"),
        "frequency_code": f("1-0-1"),
        "frequency_per_day": f(2),
        "timings": f(["morning", "night"], 0.9),
        "relation_to_food": f("after", 0.9),
        "duration_days": f(5),
        "as_needed": False,
        "instructions": f(None, 0.0),
    }
    base.update(overrides)
    return base


def extraction(*medicines: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "prescription",
        "is_prescription": True,
        "image_quality": "good",
        "medicines": list(medicines),
        "prescription_date": f(None, 0.0),
        "overall_confidence": 0.9,
        "notes_for_user": [],
    }
    base.update(overrides)
    return base


CLASSIFY_RX = {"kind": "prescription", "quality": "good", "confidence": 0.95}


def image_request(language: str = "en") -> ProcessRequest:
    return ProcessRequest.model_validate(
        {
            "request_id": "wamid.test-rx-1",
            "user": {"language": language, "age": None, "sex": None},
            "input": {
                "type": "image",
                "media_url": "http://localhost:9000/b/k?s=1",
                "mime": "image/jpeg",
            },
            "context": {"active_medications": []},
        }
    )


def make_ctx(
    provider: FakeProvider,
    settings: Settings | None = None,
    catalog: Any = None,
    interactions: Any = None,
) -> PipelineContext:
    config = settings or make_settings()
    return PipelineContext(
        settings=config,
        router=build_llm_router(config, fake_provider=provider),
        prompts=PromptRegistry(),
        templates=TemplateStore(),
        deadline=Deadline(30),
        usage=RequestUsage(),
        guard=EmergencyGuard(),
        redactor=Redactor(enabled=True),
        catalog=catalog,
        interactions=interactions,
    )
