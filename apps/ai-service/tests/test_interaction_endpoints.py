"""`POST /v1/interaction-check` and `/v1/interaction-details` (M11): auth, contract, honest output."""

from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.interactions.repository import FailingInteractionRepository
from app.interactions.service import InteractionService
from app.llm.factory import build_llm_router
from app.llm.fake import FakeProvider
from app.main import create_app
from tests.conftest import SERVICE_TOKEN, make_settings
from tests.interaction_support import core_service

HEADERS = {"X-Service-Token": SERVICE_TOKEN}
WARF = {
    "salt": "warfarin",
    "strength": "5 mg",
    "medication_id": "m-warf",
    "name": "Uniwarfin 5",
    "salt_key": "warfarin",
}
BRUFEN = {**WARF, "salt": "ibuprofen", "medication_id": "m-bru", "name": "Brufen 400",
          "salt_key": "ibuprofen"}  # fmt: skip
DOLO = {**WARF, "salt": "paracetamol", "medication_id": "m-dolo", "name": "Dolo 650",
        "salt_key": "paracetamol"}  # fmt: skip
CROCIN = {**DOLO, "medication_id": "m-cro", "name": "Crocin 500"}


def client(service: InteractionService | None = None) -> AsyncClient:
    settings = make_settings()
    app = create_app(
        settings,
        llm_router=build_llm_router(settings, fake_provider=FakeProvider([])),
        interactions=service or core_service(),
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def check_body(medications: list[dict[str, Any]], language: str = "en") -> dict[str, Any]:
    return {"request_id": "wamid.check-1", "language": language, "medications": medications}


async def test_check_needs_the_service_token():
    async with client() as c:
        res = await c.post("/v1/interaction-check", json=check_body([]))
    assert res.status_code == 401


async def test_check_finds_every_pair_among_the_stored_medicines():
    async with client() as c:
        res = await c.post(
            "/v1/interaction-check",
            json=check_body([WARF, BRUFEN, DOLO, CROCIN]),
            headers=HEADERS,
        )
    assert res.status_code == 200
    body = res.json()
    kinds = sorted((f["type"], f["salt_a"], f["salt_b"]) for f in body["interactions"]["findings"])
    assert kinds == [
        ("duplicate_ingredient", "paracetamol", "paracetamol"),
        ("interaction", "ibuprofen", "warfarin"),
        ("interaction", "paracetamol", "warfarin"),  # regular paracetamol can raise the INR
    ]
    assert "⚠️ Important:" in body["reply"]["text"]
    assert body["reply"]["text"].rstrip().endswith("before acting on this.")
    assert body["interactions"]["checked_count"] == 4


async def test_check_with_a_clean_set_says_nothing_found_not_safe():
    async with client() as c:
        res = await c.post(
            "/v1/interaction-check", json=check_body([DOLO, {**DOLO, "medication_id": "x",
                "salt": "metformin", "salt_key": "metformin", "name": "Glycomet"}]),
            headers=HEADERS,
        )  # fmt: skip
    text = res.json()["reply"]["text"]
    assert "does not mean there is none" in text and "safe" not in text.lower()


async def test_check_reports_a_database_failure():
    async with client(InteractionService(FailingInteractionRepository())) as c:
        res = await c.post(
            "/v1/interaction-check", json=check_body([WARF, BRUFEN]), headers=HEADERS
        )
    body = res.json()
    assert body["interactions"]["database_ok"] is False
    assert "could not check" in body["reply"]["text"]


async def test_check_rejects_unknown_fields():
    async with client() as c:
        res = await c.post(
            "/v1/interaction-check", json={**check_body([]), "extra": 1}, headers=HEADERS
        )
    assert res.status_code == 422


def details_body(language="en") -> dict[str, Any]:
    return {
        "request_id": "wamid.details-1",
        "language": language,
        "warnings": [
            {"type": "interaction", "salt_a": "ibuprofen", "salt_b": "warfarin",
             "labels": ["Brufen 400", "Uniwarfin 5"]},
            {"type": "duplicate_ingredient", "salt_a": "paracetamol", "salt_b": "paracetamol",
             "labels": ["Dolo 650", "Crocin 500"]},
            {"type": "interaction", "salt_a": "gone", "salt_b": "pair", "labels": []},
        ],
        "unchecked": [{"ref": "x", "label": "Mystery"}],
        "checked_count": 4,
    }  # fmt: skip


async def test_details_are_rendered_from_the_current_rows_with_source():
    async with client() as c:
        res = await c.post("/v1/interaction-details", json=details_body(), headers=HEADERS)
    assert res.status_code == 200
    text = res.json()["reply"]["text"]
    assert "Full details" in text and "Brufen 400 and Uniwarfin 5" in text
    assert "Please ask your doctor or pharmacist" in text
    assert "Source: Dawai Saathi curated list" in text
    assert "both contain paracetamol" in text
    assert "Mystery" in text  # the unchecked medicine is listed, not called safe
    assert "gone" not in text  # a warning whose row no longer exists is not repeated from memory


async def test_details_in_hindi_use_the_safe_generic_line_until_reviewed():
    async with client() as c:
        res = await c.post("/v1/interaction-details", json=details_body("hi"), headers=HEADERS)
    text = res.json()["reply"]["text"]
    assert "पूरी जानकारी" in text
    assert "ज़रूर बात करें" in text


@pytest.mark.parametrize("path", ["/v1/interaction-details", "/v1/interaction-check"])
async def test_both_endpoints_require_a_valid_body(path):
    async with client() as c:
        res = await c.post(path, json={"request_id": "x"}, headers=HEADERS)
    assert res.status_code == 422
