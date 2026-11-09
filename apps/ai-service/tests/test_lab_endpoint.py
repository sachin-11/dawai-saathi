"""`POST /v1/lab-render` (M12): auth, summary, all tests, strict contract."""

from typing import Any

from httpx import ASGITransport, AsyncClient

from app.llm.factory import build_llm_router
from app.llm.fake import FakeProvider
from app.main import create_app
from tests.conftest import SERVICE_TOKEN, make_settings
from tests.lab_support import extraction_of, lab_service, report, row

HEADERS = {"X-Service-Token": SERVICE_TOKEN}


def client() -> AsyncClient:
    settings = make_settings()
    app = create_app(
        settings,
        llm_router=build_llm_router(settings, fake_provider=FakeProvider([])),
        labs=lab_service(),
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def body(mode: str, language: str = "en", **extra: Any) -> dict[str, Any]:
    data = report(row("Haemoglobin", "11.2", "g/dL", 12.0, 15.5, "12 - 15.5", "L", "CBC"))
    data["results"][0].update(
        {"test_code": "HB", "status": "low", "range_basis": "printed", "range_text": "12–15.5"}
    )
    return {
        "request_id": "wamid.lab-1",
        "language": language,
        "mode": mode,
        "extraction": data,
        **extra,
    }


async def test_needs_the_service_token():
    async with client() as c:
        assert (await c.post("/v1/lab-render", json=body("all"))).status_code == 401


async def test_summary_and_all_tests():
    async with client() as c:
        summary = await c.post("/v1/lab-render", json=body("summary"), headers=HEADERS)
        everything = await c.post("/v1/lab-render", json=body("all", "hi"), headers=HEADERS)
    assert "• Haemoglobin: 11.2 g/dL" in summary.json()["reply"]["text"]
    assert "CBC" in everything.json()["reply"]["text"]
    assert "आपकी रिपोर्ट के सभी टेस्ट" in everything.json()["reply"]["text"]


async def test_an_unknown_key_in_the_extraction_is_rejected():
    bad = body("all")
    bad["extraction"]["patient_name"] = "Asha"
    async with client() as c:
        res = await c.post("/v1/lab-render", json=bad, headers=HEADERS)
    assert res.status_code == 422


def test_extraction_builder_matches_the_schema():
    assert extraction_of(row("Haemoglobin", "11.2", "g/dL")).kind == "lab_report"
