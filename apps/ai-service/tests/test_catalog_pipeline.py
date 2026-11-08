"""M8 end to end inside the AI service: prescription reply, generic details, typed generic query."""

from typing import ClassVar

import httpx
import pytest

from app.catalog.service import CatalogService
from app.llm.fake import FakeProvider
from app.pipeline.minimal import MinimalPipeline
from app.pipeline.rx import RxPipeline
from app.schemas.catalog import DrugMatch, GenericAlternative, GenericSuggestion, MatchMethod
from app.schemas.process import InputType, Intent, Language, ProcessRequest
from app.tools.generic_render import DetailItem, render_generic_reply, verify_generic_text
from tests.catalog_support import repo_of, seed_rows
from tests.conftest import SERVICE_TOKEN
from tests.rx_support import (
    CLASSIFY_RX,
    extraction,
    f,
    fake_fetch,
    image_request,
    make_ctx,
    medicine,
    sample_jpeg,
)

PIPELINE = RxPipeline(MinimalPipeline())
HEADERS = {"X-Service-Token": SERVICE_TOKEN}


def catalog() -> CatalogService:
    return CatalogService(repo_of(seed_rows()))


@pytest.fixture(autouse=True)
def _jpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.pipeline.rx.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg"))


def line_for(*names: str) -> dict:
    return {
        "items": [
            {"index": i, "text": f"{n} — 1 tablet, morning and night"}
            for i, n in enumerate(names, 1)
        ]
    }


async def read(*meds: dict, language: str = "en", service: CatalogService | None = None):
    provider = FakeProvider(
        [
            CLASSIFY_RX,
            extraction(*meds),
            line_for(*[m["name"]["value"] for m in meds if m["name"]["value"]]),
        ]
    )
    return await PIPELINE.run(
        image_request(language), make_ctx(provider, catalog=service or catalog())
    )


class TestPrescriptionReply:
    async def test_a_matched_medicine_with_a_priced_generic_gets_the_saving_line_and_data(self):
        output = await read(medicine())  # Dolo 650, 1 tablet 1-0-1 x 5 days
        assert "💰 A cheaper option with the same salt is available." in output.reply.text
        (rx,) = output.extraction.medicines
        assert rx.match.method is MatchMethod.exact and rx.match.salt_key == "paracetamol"
        assert rx.generic.alternatives[0].approx_savings == 15 and rx.generic.savings_known
        assert "generic" in " ".join(b.id for b in output.reply.buttons)

    async def test_hindi_line(self):
        output = await read(medicine(), language="hi")
        assert "💰 उसी साल्ट का सस्ता विकल्प उपलब्ध है।" in output.reply.text

    async def test_the_reply_never_names_a_brand_or_a_price_for_the_generic(self):
        text = (await read(medicine())).reply.text
        assert (
            "₹" not in text and "Jan Aushadhi" not in text
        )  # those are only in the details message

    async def test_an_unknown_brand_gets_no_line_and_no_match(self):
        output = await read(medicine(name=f("Zzxq 10"), strength=f(None, 0.0)))
        assert "💰" not in output.reply.text
        assert output.extraction.medicines[0].match.method is MatchMethod.none
        assert output.extraction.medicines[0].generic.reason_if_none == "no_match"

    async def test_an_excluded_medicine_is_matched_but_never_suggested(self):
        sr = medicine(name=f("Glycomet SR 500"), strength=f("500 mg", 0.9))
        output = await read(sr)
        (rx,) = output.extraction.medicines
        assert rx.match.release_type == "sr" and rx.generic.reason_if_none == "not_substitutable"
        assert "💰" not in output.reply.text

    async def test_an_unclear_dose_matches_but_gets_no_suggestion_and_no_line(self):
        output = await read(medicine(), medicine(name=f("Cetzine"), dose=f(None, 0.0)))
        second = output.extraction.medicines[1]
        assert second.match is not None and second.generic.reason_if_none == "low_confidence"
        assert output.reply.text.count("💰") == 1  # only for the first medicine

    async def test_an_unreadable_name_is_not_matched_at_all(self):
        output = await read(medicine(), medicine(name=f(None, 0.1)))
        assert (
            output.extraction.medicines[1].match is None
            and output.extraction.medicines[1].generic is None
        )

    async def test_whatever_the_model_claims_about_match_and_generic_is_discarded(self):
        lie = {
            "drug_id": "x", "salt_key": "evil", "strength_key": "1mg", "form_key": "tablet",
            "release_type": "ir", "score": 1.0, "method": "exact", "strength_basis": "prescription",
        }  # fmt: skip
        liar = medicine(name=f("Zzxq 10"))
        liar["match"] = lie
        liar["generic"] = {"alternatives": [], "reason_if_none": None}
        output = await read(liar)
        assert output.extraction.medicines[0].match.salt_key is None
        assert output.extraction.medicines[0].match.method is MatchMethod.none

    async def test_a_catalog_failure_never_breaks_the_reply(self):
        class Broken(type(repo_of([]))):
            async def exact_brand(self, brand_key):
                raise ConnectionError("db down")

        output = await read(medicine(), service=CatalogService(Broken([])))
        assert "Dolo 650" in output.reply.text
        assert output.extraction.medicines[0].match.note == "catalog_unavailable"
        assert "💰" not in output.reply.text

    async def test_without_a_catalog_the_flow_is_exactly_as_in_m7(self):
        provider = FakeProvider([CLASSIFY_RX, extraction(medicine()), line_for("Dolo 650")])
        output = await PIPELINE.run(image_request("en"), make_ctx(provider))
        assert output.extraction.medicines[0].match is None and "💰" not in output.reply.text


class TestGenericDetailsEndpoint:
    def body(self, **extra):
        alt = GenericAlternative(
            drug_id="1", brand_name="Paracetamol Tablets IP 650 mg", is_janaushadhi=True,
            price_per_unit=1.5, pack_label="10 tablet", pack_price=15.0, approx_savings=15,
            savings_basis="course",
        )  # fmt: skip
        suggestion = GenericSuggestion(alternatives=[alt], savings_known=True)
        return {
            "request_id": "wamid.gd1",
            "language": "en",
            "medicines": [
                {
                    "name": "Dolo 650",
                    "strength": "650 mg",
                    "generic": suggestion.model_dump(mode="json"),
                },
                {"name": "Glycomet SR 500", "generic": {"reason_if_none": "not_substitutable"}},
            ],
            **extra,
        }

    async def test_renders_the_details_and_makes_no_model_call(self, client, app):
        provider = FakeProvider()
        app.state.llm_router = None  # any model use would crash
        res = await client.post("/v1/generic-details", json=self.body(), headers=HEADERS)
        assert res.status_code == 200
        text = res.json()["reply"]["text"]
        assert "Dolo 650" in text and "Paracetamol Tablets IP 650 mg" in text and "₹15" in text
        assert "Jan Aushadhi" in text and "Same salt, same strength" in text
        assert "Glycomet SR 500: This kind of medicine should not be swapped" in text
        assert text.rstrip().endswith("before acting on this.") and provider.calls == []

    async def test_requires_the_service_token(self, client):
        assert (await client.post("/v1/generic-details", json=self.body())).status_code == 401

    async def test_rejects_unknown_fields_and_empty_lists(self, client):
        assert (
            await client.post("/v1/generic-details", json=self.body(extra=1), headers=HEADERS)
        ).status_code == 422
        empty = self.body() | {"medicines": []}
        assert (
            await client.post("/v1/generic-details", json=empty, headers=HEADERS)
        ).status_code == 422

    async def test_nothing_to_suggest_uses_the_none_template_with_reasons(self, client):
        body = self.body() | {
            "medicines": [
                {"name": "Thyronorm 50", "generic": {"reason_if_none": "not_substitutable"}}
            ]
        }
        text = (await client.post("/v1/generic-details", json=body, headers=HEADERS)).json()[
            "reply"
        ]["text"]
        assert "I could not suggest a cheaper generic" in text and "₹" not in text

    async def test_hindi(self, client):
        res = await client.post(
            "/v1/generic-details", json=self.body(language="hi"), headers=HEADERS
        )
        assert "उसी साल्ट के विकल्प" in res.json()["reply"]["text"]


class TestGroundingOfTheDetails:
    ITEMS: ClassVar[list[DetailItem]] = [
        DetailItem(
            1, "Dolo 650", None,
            GenericSuggestion(alternatives=[GenericAlternative(
                drug_id="1", brand_name="Real Generic 650", is_janaushadhi=True, price_per_unit=1.5,
                pack_label="10 tablet", pack_price=15.0, approx_savings=15, savings_basis="course")]),
        )
    ]  # fmt: skip

    def test_a_clean_text_passes(self):
        assert verify_generic_text(render_generic_reply(self.ITEMS, Language.en), self.ITEMS) == []

    def test_an_invented_amount_is_caught(self):
        text = render_generic_reply(self.ITEMS, Language.en).replace("₹15", "₹150")
        assert "amount_not_in_data" in verify_generic_text(text, self.ITEMS)

    def test_an_invented_brand_is_caught(self):
        text = render_generic_reply(self.ITEMS, Language.en).replace(
            "Real Generic 650", "Invented Brand"
        )
        assert "brand_not_in_data" in verify_generic_text(text, self.ITEMS)

    def test_a_failed_check_falls_back_to_a_text_without_any_price(self, monkeypatch):
        monkeypatch.setattr(
            "app.tools.generic_render.verify_generic_text", lambda *_: ["amount_not_in_data"]
        )
        text = render_generic_reply(self.ITEMS, Language.en)
        assert "₹" not in text and "Real Generic 650" not in text and "I could not suggest" in text


class TestTypedGenericQuery:
    def request(self, text: str, language: str = "en") -> ProcessRequest:
        return ProcessRequest.model_validate(
            {
                "request_id": "wamid.q1",
                "user": {"language": language},
                "input": {"type": InputType.text, "text": text},
            }
        )

    async def ask(self, text: str, language: str = "en", service: CatalogService | None = None):
        ctx = make_ctx(FakeProvider(), catalog=service or catalog())
        return await MinimalPipeline().run(self.request(text, language), ctx)

    async def test_dolo_650_ka_generic_batao(self):
        output = await self.ask("Dolo 650 ka generic batao")
        assert output.intent is Intent.generic_query and not output.emergency
        assert (
            "Dolo 650" in output.reply.text and "Paracetamol Tablets IP 650 mg" in output.reply.text
        )
        assert "Same salt, same strength" in output.reply.text
        assert (
            "about ₹15 saved per pack" in output.reply.text
        )  # no course known for a typed question

    async def test_hindi_reply_and_devanagari_name(self):
        output = await self.ask("डोलो 650 का generic batao", "hi")
        assert "उसी साल्ट के विकल्प" in output.reply.text

    async def test_a_generic_name_with_a_strength_is_matched_by_salt(self):
        output = await self.ask("paracetamol 500 mg ka generic batao")
        assert "Paracetamol Tablets IP 500 mg" in output.reply.text
        assert "saved" not in output.reply.text  # no brand price: never a saving claim

    async def test_no_medicine_named_asks_for_one(self):
        output = await self.ask("generic batao")
        assert output.intent is Intent.generic_query and "Which medicine" in output.reply.text

    async def test_an_unknown_medicine_says_it_is_not_in_the_list(self):
        output = await self.ask("Zzxq 10 ka generic batao")
        assert (
            "I could not find it in my medicine list" in output.reply.text
            and "₹" not in output.reply.text
        )

    async def test_a_narrow_therapeutic_index_drug_is_never_suggested(self):
        output = await self.ask("Thyronorm 50 mcg ka generic batao")
        assert "should not be swapped" in output.reply.text and "₹" not in output.reply.text

    async def test_without_a_catalog_it_is_the_old_coming_soon(self):
        ctx = make_ctx(FakeProvider(), catalog=None)
        output = await MinimalPipeline().run(self.request("Dolo 650 ka generic batao"), ctx)
        assert "coming soon" in output.reply.text

    async def test_a_catalog_outage_is_not_reported_as_an_unknown_medicine(self):
        class Broken(type(repo_of([]))):
            async def exact_brand(self, brand_key):
                raise ConnectionError("db down")

        output = await self.ask("Dolo 650 ka generic batao", service=CatalogService(Broken([])))
        assert "cannot check my medicine list right now" in output.reply.text
        assert "could not find" not in output.reply.text

    async def test_an_emergency_is_still_answered_first(self):
        output = await self.ask("seene me dard ho raha hai, generic batao")
        assert output.emergency and output.intent is Intent.emergency


class TestVectorAndHttpAdapters:
    async def test_pinecone_query_and_upsert_use_the_documented_rest_calls(self):
        from app.catalog.vector import HashingEmbedder, PineconeVectorStore
        from tests.catalog_support import row

        calls: list[tuple[str, dict]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            calls.append((request.url.path, json.loads(request.content)))
            assert request.headers["Api-Key"] == "k"
            if request.url.path == "/query":
                return httpx.Response(200, json={"matches": [{"id": "d1", "score": 0.91}]})
            return httpx.Response(200, json={"upsertedCount": 1})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        store = PineconeVectorStore("idx.example", "k", HashingEmbedder(), client=client)
        assert await store.query("pantop 40", 3) == [("d1", 0.91)]
        assert await store.upsert([row(brand_name="Pantop 40")]) == 1
        assert [path for path, _ in calls] == ["/query", "/vectors/upsert"]
        assert calls[0][1]["topK"] == 3 and len(calls[0][1]["vector"]) == 256

    async def test_http_embedder_posts_openai_style_and_sorts_by_index(self):
        from app.catalog.vector import HttpEmbedder

        def handler(request: httpx.Request) -> httpx.Response:
            assert (
                request.url.path == "/v1/embeddings"
                and request.headers["Authorization"] == "Bearer s"
            )
            return httpx.Response(
                200,
                json={"data": [{"index": 1, "embedding": [2.0]}, {"index": 0, "embedding": [1.0]}]},
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        embedder = HttpEmbedder("https://api.example/v1", "s", "m", client)
        assert await embedder.embed(["a", "b"]) == [[1.0], [2.0]]

    async def test_the_hashing_embedder_is_deterministic_and_normalised(self):
        from app.catalog.vector import HashingEmbedder, cosine

        a, b = await HashingEmbedder().embed(["pantop 40", "pantop 40"])
        assert a == b and cosine(a, b) == pytest.approx(1.0)
        (c,) = await HashingEmbedder().embed(["totally different words"])
        assert cosine(a, c) < 0.5


def test_a_match_object_round_trips_through_json():
    match = DrugMatch(drug_id="1", salt_key="paracetamol", score=0.9, method=MatchMethod.trgm)
    assert DrugMatch.model_validate_json(match.model_dump_json()) == match
