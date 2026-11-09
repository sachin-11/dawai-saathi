"""Helpers for the lab report tests (M12): an in-memory lab catalog, extraction builders, requests."""

from datetime import date
from typing import Any

from app.labs.catalog import InMemoryLabRepository
from app.labs.service import LabService
from app.schemas.lab_report import LabReportExtraction, LabResult
from app.schemas.process import ProcessRequest
from app.tools.lab_normalize import LabIndex

CLASSIFY_LAB = {"kind": "lab_report", "quality": "good", "confidence": 0.95}


def lab_service() -> LabService:
    return LabService(InMemoryLabRepository())


async def lab_index() -> LabIndex:
    index = await lab_service().index()
    assert index is not None
    return index


def f(value: Any, confidence: float = 0.95) -> dict[str, Any]:
    return {"value": value, "confidence": confidence}


def row(
    name: str,
    value: str,
    unit: str | None = None,
    low: float | None = None,
    high: float | None = None,
    ref_text: str | None = None,
    flag: str | None = None,
    section: str | None = None,
    **confidence: float,
) -> dict[str, Any]:
    """One printed result, as the model returns it (before normalisation)."""
    return {
        "raw_test_name": f(name, confidence.get("c_name", 0.95)),
        "value_raw": f(value, confidence.get("c_value", 0.95)),
        "unit": f(unit, confidence.get("c_unit", 0.95)),
        "lab_ref_low": f(low, confidence.get("c_range", 0.95) if low is not None else 0.0),
        "lab_ref_high": f(high, confidence.get("c_range", 0.95) if high is not None else 0.0),
        "lab_ref_text": f(ref_text, confidence.get("c_range", 0.95) if ref_text else 0.0),
        "lab_flag": f(flag, 0.9 if flag else 0.0),
        "section": section,
    }


def report(
    *rows: dict[str, Any],
    report_date: str | None = "2026-11-12",
    age: int | None = None,
    sex: str | None = None,
    overall: float = 0.9,
    quality: str = "good",
    is_lab: bool = True,
) -> dict[str, Any]:
    return {
        "kind": "lab_report",
        "is_lab_report": is_lab,
        "image_quality": quality,
        "report_date": f(report_date, 0.95 if report_date else 0.0),
        "patient_age": f(age, 0.95 if age is not None else 0.0),
        "patient_sex": f(sex, 0.95 if sex else 0.0),
        "results": list(rows),
        "overall_confidence": overall,
        "notes_for_user": [],
    }


def extraction_of(*rows: dict[str, Any], **kwargs: Any) -> LabReportExtraction:
    return LabReportExtraction.model_validate(report(*rows, **kwargs))


def result_of(**kwargs: Any) -> LabResult:
    return LabResult.model_validate(row(**kwargs))


def lab_image_request(
    language: str = "en",
    previous: list[dict[str, Any]] | None = None,
    age: int | None = None,
    sex: str | None = None,
) -> ProcessRequest:
    return ProcessRequest.model_validate(
        {
            "request_id": "wamid.test-lab-1",
            "user": {"language": language, "age": age, "sex": sex},
            "input": {
                "type": "image",
                "media_url": "http://localhost:9000/b/k?s=1",
                "mime": "image/jpeg",
            },
            "context": {"active_medications": [], "previous_lab_results": previous or []},
        }
    )


def previous(code: str, value: float, unit: str, when: date) -> dict[str, Any]:
    return {"test_code": code, "value": value, "unit": unit, "report_date": when.isoformat()}
