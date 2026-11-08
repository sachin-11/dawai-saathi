"""Shared helpers for the interaction tests (M11): the REAL curated core list as in-memory rows."""

import importlib.util
from pathlib import Path
from typing import Any

from app.interactions.repository import InMemoryInteractionRepository, InteractionRow
from app.interactions.service import InteractionService
from app.schemas.process import ProcessRequest
from app.tools.interaction_check import CheckedMedication

ROOT = Path(__file__).parents[3]
_SCRIPT = ROOT / "data" / "scripts" / "interaction_sources.py"
_spec = importlib.util.spec_from_file_location("interaction_sources", _SCRIPT)
assert _spec and _spec.loader
sources = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sources)

_counter = 0


def pair(salt_a: str, salt_b: str, severity: str = "major", effect: str = "bleeding", **kw: Any):
    """One interaction row for a unit test (salts are ordered for you)."""
    global _counter
    _counter += 1
    a, b = sorted((salt_a, salt_b))
    values: dict[str, Any] = {
        "id": f"ix-{_counter}",
        "salt_a": a,
        "salt_b": b,
        "severity": severity,
        "effect_code": effect,
        "summary": "s",
        "management_en": "Please ask your doctor or pharmacist before taking these together.",
        "management_hi": "इन दवाइयों को साथ लेने से पहले अपने डॉक्टर या फ़ार्मासिस्ट से ज़रूर बात करें।",
        "hi_reviewed": False,
        "source": "test source",
    }
    values.update(kw)
    return InteractionRow(**values)


def core_rows() -> list[InteractionRow]:
    """The committed core list (classes expanded), exactly what `make seed` stores."""
    result = sources.load_interactions(
        ROOT / "data" / "seed" / "interactions_core.csv",
        ROOT / "data" / "seed" / "interaction_classes.csv",
    )
    assert not result.rejected, dict(result.rejected)
    return [
        InteractionRow(
            id=f"core-{index}",
            salt_a=r.salt_a,
            salt_b=r.salt_b,
            severity=r.severity,
            effect_code=r.effect_code,
            summary=r.summary,
            management_en=r.management_en,
            management_hi=r.management_hi,
            hi_reviewed=r.hi_reviewed,
            source=r.source,
            source_ref=r.source_ref,
            source_version=r.source_version,
        )
        for index, r in enumerate(result.records)
    ]


def core_repo() -> InMemoryInteractionRepository:
    return InMemoryInteractionRepository(core_rows())


def core_service() -> InteractionService:
    return InteractionService(core_repo(), match_min=0.8)


def med(ref: str, salt_key: str | None, label: str | None = None, *, new: bool = True):
    return CheckedMedication(ref=ref, label=label or ref, salt_key=salt_key, is_new=new)


def with_context(request: ProcessRequest, active: list[dict[str, Any]]) -> ProcessRequest:
    data = request.model_dump(mode="json")
    data["context"] = {"active_medications": active}
    return ProcessRequest.model_validate(data)
