"""Each graph node in isolation, with fake tools (M9). The tools themselves keep their own tests."""

from decimal import Decimal
from typing import Any, ClassVar

import pytest

from app.graph.nodes.classify import classify
from app.graph.nodes.composer import composer
from app.graph.nodes.emergency_guard import emergency_classifier, emergency_guard
from app.graph.nodes.prepare_image import prepare_image
from app.graph.nodes.redact import redact
from app.graph.nodes.rx_nodes import (
    confidence_gate,
    extract_query,
    generic_finder,
    normalize_drugs,
    validate_rx,
    vision_extract_rx,
)
from app.graph.nodes.templates import rx_fallback_renderer, templates
from app.graph.nodes.transcribe import transcribe
from app.graph.nodes.verifier import collect_failures, verifier
from app.graph.state import GraphState, VerificationResult
from app.llm.fake import FakeProvider
from app.llm.types import ImageInput, LLMServerError
from app.schemas.catalog import GenericAlternative, GenericSuggestion
from app.schemas.prescription import PrescriptionExtraction
from app.schemas.process import Intent, Language, Reply
from app.tools.rx_enrich import enrich_with_catalog
from app.tools.rx_gate import apply_gate
from app.tools.rx_validate import validate_extraction
from tests.catalog_support import repo_of, row
from tests.graph_support import (
    audio_request,
    runtime_for,
    seeded_catalog,
    state_for,
    text_request,
)
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

IMAGE = ImageInput(b"jpeg", "image/jpeg")
THRESHOLD = 0.75


async def call(node, state: GraphState, provider: FakeProvider | None = None, catalog=None):
    ctx = make_ctx(provider or FakeProvider(), catalog=catalog)
    return await node(state, runtime=runtime_for(ctx)), ctx


async def gated_state(*meds: dict[str, Any], catalog=None, **extra: Any) -> GraphState:
    """A state as it is when it reaches the composer: validated, matched and gated."""
    validated = validate_extraction(
        PrescriptionExtraction.model_validate(extraction(*meds)), THRESHOLD
    )
    enriched = await enrich_with_catalog(validated, catalog or seeded_catalog(), THRESHOLD)
    gate = apply_gate(enriched, THRESHOLD)
    return state_for(
        image_request(),
        rx_extraction=gate.extraction,
        warnings=gate.warnings,
        intent=Intent.prescription,
        **extra,
    )


# ---------------------------------------------------------------------------- emergency


class TestEmergencyNodes:
    async def test_the_rules_match_on_the_raw_text_and_set_the_emergency_reply(self):
        update, _ = await call(
            emergency_guard, state_for(text_request("seene me dard ho raha hai"))
        )
        assert update["emergency"].is_emergency and update["template_key"] == "emergency.general"
        assert update["intent"] is Intent.emergency

    async def test_self_harm_gets_its_own_text(self):
        update, _ = await call(emergency_guard, state_for(text_request("mujhe jeena nahi hai")))
        assert update["template_key"] == "emergency.self_harm"

    async def test_no_match_keeps_the_raw_text_for_redaction_and_asks_nothing_else(self):
        update, _ = await call(emergency_guard, state_for(text_request("what can you do")))
        assert not update["emergency"].is_emergency and "template_key" not in update
        assert update["raw_text"] == "what can you do"

    async def test_the_guard_never_runs_a_model(self):
        _, ctx = await call(emergency_guard, state_for(text_request("hello there")))
        assert ctx.usage.cost_usd == 0 and ctx.usage.model is None

    async def test_redact_masks_phone_numbers_and_drops_the_raw_text(self):
        state = state_for(text_request("x"), raw_text="my number is 9876543210, what can you do")
        update, _ = await call(redact, state)
        assert "9876543210" not in update["redacted_text"] and "[PHONE]" in update["redacted_text"]
        assert update["raw_text"] is None  # nothing after this node can read the raw words

    async def test_the_classifier_flags_what_the_rules_missed(self):
        provider = FakeProvider([{"is_emergency": True, "category": "stroke", "confidence": 0.9}])
        state = state_for(
            text_request("x"), redacted_text="meri maa ka chehra ek taraf latak gaya hai"
        )
        update, _ = await call(emergency_classifier, state, provider)
        assert update["emergency"].is_emergency and update["template_key"] == "emergency.general"

    async def test_a_low_confidence_classifier_does_not_flag(self):
        provider = FakeProvider([{"is_emergency": True, "category": "cardiac", "confidence": 0.3}])
        state = state_for(text_request("x"), redacted_text="kuch pareshani si hai aajkal")
        update, _ = await call(emergency_classifier, state, provider)
        assert not update["emergency"].is_emergency and "template_key" not in update

    async def test_a_failing_classifier_fails_safe_to_the_rules(self):
        provider = FakeProvider([LLMServerError(), LLMServerError()])
        state = state_for(text_request("x"), redacted_text="kuch pareshani si hai aajkal")
        update, _ = await call(emergency_classifier, state, provider)
        assert (
            not update["emergency"].is_emergency
            and update["emergency"].classifier_status == "unavailable"
        )


# ---------------------------------------------------------------------------- input and classify


class TestInputNodes:
    async def test_transcribe_without_a_speech_provider_says_so_and_names_112(self):
        update, _ = await call(transcribe, state_for(audio_request()))
        assert update["template_key"] == "voice.stt_unavailable"
        assert update["intent"] is Intent.other

    async def test_prepare_image_returns_the_images_without_writing_anything_else(
        self, monkeypatch
    ):
        monkeypatch.setattr(
            "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
        )
        update, _ = await call(prepare_image, state_for(image_request()))
        assert len(update["images"]) == 1 and "template_key" not in update

    async def test_a_file_we_cannot_use_is_a_static_reply(self, monkeypatch):
        monkeypatch.setattr(
            "app.tools.image_input.fetch_media", fake_fetch(b"not an image", "image/jpeg")
        )
        update, _ = await call(prepare_image, state_for(image_request()))
        assert update["template_key"] == "rx.bad_file" and "images" not in update

    async def test_classify_text_picks_a_static_reply_for_simple_intents(self):
        for text, key, intent in (
            ("kya kar sakte ho?", "help", Intent.help),
            ("hello", "greeting", Intent.greeting),
            ("cricket score batao", "out_of_scope", Intent.out_of_scope),
        ):
            update, _ = await call(classify, state_for(text_request(text), redacted_text=text))
            assert (update["template_key"], update["intent"]) == (key, intent), text

    async def test_classify_lab_and_interaction_questions_are_placeholders(self):
        for text, intent in (
            ("meri blood test report samjhao", Intent.lab_report),
            ("do dawai saath me le sakta hoon?", Intent.interaction_query),
        ):
            update, _ = await call(classify, state_for(text_request(text), redacted_text=text))
            assert update["template_key"] == "coming_soon" and update["intent"] is intent

    async def test_a_generic_question_goes_on_when_there_is_a_catalog(self):
        text = "Dolo 650 ka generic batao"
        state = state_for(text_request(text), redacted_text=text)
        update, _ = await call(classify, state, catalog=seeded_catalog())
        assert update == {
            "intent": Intent.generic_query,
            **{k: v for k, v in update.items() if k in {"node_timings", "cost_usd"}},
        }
        update, _ = await call(classify, state, catalog=None)
        assert update["template_key"] == "coming_soon"

    @pytest.mark.parametrize(
        ("answer", "key", "intent"),
        [
            (
                {"kind": "lab_report", "quality": "good", "confidence": 0.9},
                "rx.lab_report",
                Intent.lab_report,
            ),
            (
                {"kind": "medicine_strip", "quality": "good", "confidence": 0.9},
                "rx.medicine_strip",
                Intent.other,
            ),
            ({"kind": "other", "quality": "good", "confidence": 0.9}, "rx.other", Intent.other),
            (
                {"kind": "prescription", "quality": "unreadable", "confidence": 0.9},
                "rx.unreadable",
                Intent.other,
            ),
            (
                {"kind": "prescription", "quality": "good", "confidence": 0.1},
                "rx.other",
                Intent.other,
            ),
        ],
    )
    async def test_classify_image(self, answer, key, intent):
        update, _ = await call(
            classify, state_for(image_request(), images=[IMAGE]), FakeProvider([answer])
        )
        assert (update["template_key"], update["intent"]) == (key, intent)

    async def test_a_prescription_photo_continues_to_extraction(self):
        update, _ = await call(
            classify, state_for(image_request(), images=[IMAGE]), FakeProvider([CLASSIFY_RX])
        )
        assert update["image_kind"] == "prescription" and update["intent"] is Intent.prescription
        assert "template_key" not in update


# ---------------------------------------------------------------------------- vision_extract_rx


class TestVisionExtract:
    def state(self, **fields) -> GraphState:
        return state_for(image_request(), images=[IMAGE], **fields)

    async def test_success(self):
        update, ctx = await call(
            vision_extract_rx, self.state(), FakeProvider([extraction(medicine())])
        )
        assert update["rx_extraction"].medicines[0].name.value == "Dolo 650"
        assert update["retries"] == {"vision_extract_rx": 1} and "errors" not in update
        assert "rx_extract_v1" in ctx.usage.prompt_versions

    async def test_the_model_gets_the_image_but_state_never_leaks_it(self):
        provider = FakeProvider([extraction(medicine())])
        update, _ = await call(vision_extract_rx, self.state(), provider)
        assert provider.calls[0]["images"] == 1
        assert "images" not in update  # a node never writes the file back into the state
        assert not any(isinstance(value, ImageInput) for value in update.values())
        assert b"jpeg" not in str(update).encode()

    async def test_a_first_schema_failure_asks_for_a_retry_without_a_reply(self):
        bad = FakeProvider(
            [{"nonsense": 1}, {"still": "bad"}]
        )  # first answer + the router's own repair
        update, _ = await call(vision_extract_rx, self.state(), bad)
        assert "rx_extraction" not in update and "template_key" not in update
        assert update["retries"] == {"vision_extract_rx": 1}
        assert [e.code for e in update["errors"]] == ["schema_invalid"]

    async def test_the_retry_uses_the_stricter_prompt(self):
        provider = FakeProvider([extraction(medicine())])
        update, ctx = await call(
            vision_extract_rx, self.state(retries={"vision_extract_rx": 1}), provider
        )
        assert "rx_extract_strict_v1" in ctx.usage.prompt_versions and update["retries"] == {
            "vision_extract_rx": 2
        }
        system = provider.calls[0]["messages"][0].content
        assert "RETRY" in system and "EXACTLY ONE JSON object" in system

    async def test_a_failure_after_the_retry_says_so_and_never_guesses(self):
        bad = FakeProvider([{"x": 1}, {"y": 2}])
        update, _ = await call(vision_extract_rx, self.state(retries={"vision_extract_rx": 1}), bad)
        assert (
            update["template_key"] == "rx.needs_review" and update["intent"] is Intent.prescription
        )
        assert (
            update["rx_extraction"].status == "needs_review"
            and update["rx_extraction"].medicines == []
        )
        assert [w.type.value for w in update["warnings"]] == ["low_confidence"]


# ---------------------------------------------------------------------------- the domain chain


class TestDomainNodes:
    async def test_validate_rx_redacts_free_text_and_fixes_codes(self):
        med = medicine(
            frequency_code=f("TDS"), frequency_per_day=f(2), instructions=f("call 9876543210", 0.9)
        )
        state = state_for(
            image_request(), rx_extraction=PrescriptionExtraction.model_validate(extraction(med))
        )
        update, _ = await call(validate_rx, state)
        result = update["rx_extraction"].medicines[0]
        assert result.frequency_per_day.value == 3 and "9876543210" not in (
            result.instructions.value or ""
        )

    async def test_normalize_drugs_matches_each_medicine_and_skips_unreadable_names(self):
        ext = PrescriptionExtraction.model_validate(
            extraction(medicine(), medicine(name=f(None, 0.1)))
        )
        update, _ = await call(
            normalize_drugs, state_for(image_request(), rx_extraction=ext), catalog=seeded_catalog()
        )
        first, second = update["drug_matches"]
        assert first.salt_key == "paracetamol" and second is None

    async def test_without_a_catalog_nothing_is_matched(self):
        ext = PrescriptionExtraction.model_validate(extraction(medicine()))
        update, _ = await call(
            normalize_drugs, state_for(image_request(), rx_extraction=ext), catalog=None
        )
        assert update["drug_matches"] == [None]

    async def test_generic_finder_attaches_match_and_suggestion_to_the_extraction(self):
        catalog = seeded_catalog()
        ext = validate_extraction(
            PrescriptionExtraction.model_validate(extraction(medicine())), THRESHOLD
        )
        matched, _ = await call(
            normalize_drugs, state_for(image_request(), rx_extraction=ext), catalog=catalog
        )
        state = state_for(image_request(), rx_extraction=ext, drug_matches=matched["drug_matches"])
        update, _ = await call(generic_finder, state, catalog=catalog)
        medicine_out = update["rx_extraction"].medicines[0]
        assert medicine_out.match.salt_key == "paracetamol" and medicine_out.generic.alternatives
        assert (
            update["generics"][0] is medicine_out.generic
            or update["generics"][0] == medicine_out.generic
        )

    async def test_whatever_the_model_claimed_about_match_and_generic_is_replaced(self):
        liar = medicine()
        liar["generic"] = {"alternatives": [], "reason_if_none": None}
        ext = PrescriptionExtraction.model_validate(extraction(liar))
        state = state_for(image_request(), rx_extraction=ext, drug_matches=[None])
        update, _ = await call(generic_finder, state, catalog=seeded_catalog())
        assert (
            update["rx_extraction"].medicines[0].match is None
            and update["rx_extraction"].medicines[0].generic is None
        )

    async def test_confidence_gate_marks_unclear_medicines_and_warns(self):
        ext = validate_extraction(
            PrescriptionExtraction.model_validate(
                extraction(medicine(), medicine(name=f("Pantop 40"), dose=f(None, 0.0)))
            ),
            THRESHOLD,
        )
        update, _ = await call(confidence_gate, state_for(image_request(), rx_extraction=ext))
        assert update["rx_extraction"].status == "needs_review" and "template_key" not in update
        assert [w.detail for w in update["warnings"]] == ["medicine 2: dose not clear"]

    async def test_confidence_gate_unreadable_keeps_the_extraction_but_shows_no_medicines(self):
        ext = validate_extraction(
            PrescriptionExtraction.model_validate(extraction(medicine(name=f(None, 0.1)))),
            THRESHOLD,
        )
        update, _ = await call(confidence_gate, state_for(image_request(), rx_extraction=ext))
        assert (
            update["template_key"] == "rx.unreadable" and update["rx_extraction"].status == "failed"
        )
        assert update["gate_failure"] == "no_readable_medicine"

    async def test_confidence_gate_not_a_prescription_drops_the_extraction(self):
        ext = validate_extraction(
            PrescriptionExtraction.model_validate(extraction(medicine(), is_prescription=False)),
            THRESHOLD,
        )
        update, _ = await call(confidence_gate, state_for(image_request(), rx_extraction=ext))
        assert (
            update["template_key"] == "rx.other"
            and update["rx_extraction"] is None
            and update["intent"] is Intent.other
        )


class TestTypedQuery:
    TEXT = "Dolo 650 ka generic batao"

    def state(self, **fields) -> GraphState:
        return state_for(
            text_request(self.TEXT), redacted_text=self.TEXT, intent=Intent.generic_query, **fields
        )

    async def test_extract_query_copies_the_name_and_strength(self):
        update, _ = await call(extract_query, self.state())
        assert update["query_name"] == "Dolo 650" and update["query_strength"] is None

    async def test_no_medicine_named_asks_for_one(self):
        state = state_for(
            text_request("generic batao"),
            redacted_text="generic batao",
            intent=Intent.generic_query,
        )
        update, _ = await call(extract_query, state)
        assert update["template_key"] == "generic_query_ask_name"

    async def test_normalize_then_finder_produce_the_list_the_reply_shows(self):
        catalog = seeded_catalog()
        matched, _ = await call(normalize_drugs, self.state(query_name="Dolo 650"), catalog=catalog)
        state = self.state(query_name="Dolo 650", drug_matches=matched["drug_matches"])
        update, _ = await call(generic_finder, state, catalog=catalog)
        (item,) = update["generic_items"]
        assert (
            item.name == "Dolo 650" and item.generic.alternatives and "rx_extraction" not in update
        )

    async def test_a_catalog_outage_is_not_reported_as_an_unknown_medicine(self):
        class Broken(type(repo_of([]))):
            async def exact_brand(self, brand_key):
                raise ConnectionError("db down")

        from app.catalog.service import CatalogService

        update, _ = await call(
            normalize_drugs, self.state(query_name="Dolo 650"), catalog=CatalogService(Broken([]))
        )
        assert update["template_key"] == "generic_query_unavailable"


# ---------------------------------------------------------------------------- composer


class TestComposer:
    LINE: ClassVar[dict[str, Any]] = {
        "items": [{"index": 1, "text": "Dolo 650 — 1 tablet, morning and night"}]
    }

    async def test_the_llm_lines_become_a_candidate_reply_with_buttons(self):
        state = await gated_state(medicine())
        update, ctx = await call(composer, state, FakeProvider([self.LINE]))
        assert update["reply_source"] == "llm" and update["llm_lines"] == {
            1: "Dolo 650 — 1 tablet, morning and night"
        }
        assert "Dolo 650 — 1 tablet, morning and night" in update["reply"].text
        assert [b.id.split(":")[1] for b in update["reply"].buttons] == [
            "reminders",
            "generic",
            "wrong",
        ]
        assert {"rx_compose_v1", "rx_reply_v1"} <= set(ctx.usage.prompt_versions)

    async def test_the_model_sees_structured_readable_data_only(self):
        provider = FakeProvider([self.LINE])
        state = await gated_state(medicine(raw_text=f("RAW-OCR-LINE")), medicine(name=f(None, 0.1)))
        await call(composer, state, provider)
        (call_made,) = provider.calls
        assert call_made["images"] == 0
        text = " ".join(m.content for m in call_made["messages"])
        assert "RAW-OCR-LINE" not in text and '"index": 2' not in text

    async def test_when_nothing_is_readable_no_model_is_called(self):
        state = await gated_state(medicine(name=f(None, 0.1)))
        provider = FakeProvider()
        update, _ = await call(composer, state, provider)
        assert (
            provider.calls == []
            and update["reply_source"] == "template"
            and "llm_lines" not in update
        )

    async def test_a_failing_model_gives_the_template_and_a_fallback_status(self):
        state = await gated_state(medicine())
        update, _ = await call(composer, state, FakeProvider([LLMServerError(), LLMServerError()]))
        assert update["reply_source"] == "template" and "Dolo 650" in update["reply"].text
        assert update["compose_problems"] == ["llm_unavailable"]  # both attempts failed
        assert update["node_timings"][0].status == "fallback"

    async def test_a_typed_query_is_rendered_from_templates_without_a_model(self):
        catalog = seeded_catalog()
        matched, _ = await call(
            normalize_drugs, TestTypedQuery().state(query_name="Dolo 650"), catalog=catalog
        )
        base = TestTypedQuery().state(query_name="Dolo 650", drug_matches=matched["drug_matches"])
        found, _ = await call(generic_finder, base, catalog=catalog)
        state = base.model_copy(update={"generic_items": found["generic_items"]})
        provider = FakeProvider()
        update, _ = await call(composer, state, provider)
        assert provider.calls == [] and update["reply_source"] == "template"
        assert (
            "Paracetamol Tablets IP 650 mg" in update["reply"].text and "₹" in update["reply"].text
        )


# ---------------------------------------------------------------------------- verifier


async def verified(state: GraphState, catalog=None) -> list[str]:
    ctx = make_ctx(FakeProvider(), catalog=catalog or seeded_catalog())
    return await collect_failures(state, ctx)


async def composed(*meds, catalog=None, provider: FakeProvider | None = None) -> GraphState:
    state = await gated_state(*meds, catalog=catalog)
    update, _ = await call(
        composer,
        state,
        provider or FakeProvider([TestComposer.LINE]),
        catalog=catalog or seeded_catalog(),
    )
    return state.model_copy(update=update)


class TestVerifier:
    async def test_a_clean_llm_reply_passes(self):
        assert await verified(await composed(medicine())) == []

    async def test_the_node_reports_ok_and_codes_only(self):
        state = await composed(medicine())
        update, _ = await call(verifier, state, catalog=seeded_catalog())
        assert update["verification"] == VerificationResult(ok=True, failures=[])

    async def test_a_line_with_an_invented_medicine_fails(self):
        lie = {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet, also take Crocin"}]}
        failures = await verified(await composed(medicine(), provider=FakeProvider([lie])))
        assert "unknown_word" in failures

    async def test_a_number_that_is_not_in_the_data_fails(self):
        lie = {"items": [{"index": 1, "text": "Dolo 650 — 1 tablet for 14 days"}]}
        assert "number_not_in_data" in await verified(
            await composed(medicine(), provider=FakeProvider([lie]))
        )

    async def test_a_reply_that_leaves_out_a_medicine_name_fails(self):
        state = await composed(medicine())
        stripped = state.reply.model_copy(
            update={"text": state.reply.text.replace("Dolo 650", "it")}
        )
        assert "name_missing" in await verified(state.model_copy(update={"reply": stripped}))

    async def test_a_low_confidence_medicine_must_be_flagged(self):
        state = await composed(medicine(), medicine(name=f(None, 0.1)))
        assert await verified(state) == []
        unflagged = state.reply.model_copy(
            update={"text": state.reply.text.replace("could not read", "saw")}
        )
        assert "low_confidence_not_flagged" in await verified(
            state.model_copy(update={"reply": unflagged})
        )

    async def test_a_rupee_amount_never_belongs_in_the_main_reply(self):
        state = await composed(medicine())
        priced = state.reply.model_copy(update={"text": state.reply.text + " ₹5"})
        assert "unexpected_amount" in await verified(state.model_copy(update={"reply": priced}))

    async def test_the_disclaimer_is_required(self):
        state = await composed(medicine())
        bare = state.reply.model_copy(
            update={"text": state.reply.text.split("\n\n⚠️ I am not a doctor")[0]}
        )
        assert "disclaimer_missing" in await verified(state.model_copy(update={"reply": bare}))

    async def test_reply_limits(self):
        state = await composed(medicine())
        many = Reply.model_construct(
            language=Language.en, text=state.reply.text, buttons=state.reply.buttons * 2
        )
        wide = state.reply.buttons[0].model_copy(update={"title": "x" * 21})
        titled = Reply.model_construct(language=Language.en, text=state.reply.text, buttons=[wide])
        huge = Reply.model_construct(
            language=Language.en, text=state.reply.text + "x" * 5000, buttons=[]
        )
        assert "too_many_buttons" in await verified(state.model_copy(update={"reply": many}))
        assert "button_title_too_long" in await verified(state.model_copy(update={"reply": titled}))
        assert "reply_too_long" in await verified(state.model_copy(update={"reply": huge}))

    async def test_a_state_without_a_reply_fails(self):
        assert await verified(state_for(image_request())) == ["no_reply"]


class TestVerifierRechecksTheGenericRules:
    """Defence in depth: even if an earlier node let something through, the verifier stops it."""

    def tamper(self, state: GraphState, **changes: Any) -> GraphState:
        medicines = list(state.rx_extraction.medicines)
        medicines[0] = medicines[0].model_copy(update=changes)
        return state.model_copy(
            update={
                "rx_extraction": state.rx_extraction.model_copy(update={"medicines": medicines})
            }
        )

    async def test_a_genuine_suggestion_passes(self):
        state = await composed(medicine())
        assert state.rx_extraction.medicines[0].generic.alternatives
        assert await verified(state) == []

    async def test_an_alternative_with_another_strength_is_caught(self):
        original = row(brand_name="Brandx", strength_key="650mg", mrp=Decimal(30))
        wrong = row(brand_name="Wrong", strength_key="500mg", mrp=Decimal(5), is_janaushadhi=True)
        state = await composed(medicine(name=f("Brandx 650")), catalog=None)
        good = state.rx_extraction.medicines[0]
        alt = GenericAlternative(
            drug_id=wrong.id, brand_name="Wrong", is_janaushadhi=True, price_per_unit=0.5
        )
        from app.catalog.service import CatalogService

        catalog = CatalogService(repo_of([original, wrong]))
        match = (
            good.match.model_copy(
                update={
                    "drug_id": original.id,
                    "salt_key": "paracetamol",
                    "strength_key": "650mg",
                    "form_key": "tablet",
                    "release_type": "ir",
                    "score": 1.0,
                    "method": "exact",
                    "strength_basis": "brand_name",
                }
            )
            if good.match
            else None
        )
        assert match is not None
        bad = self.tamper(state, match=match, generic=GenericSuggestion(alternatives=[alt]))
        assert "generic_four_key" in await verified(bad, catalog=catalog)

    async def test_a_suggestion_for_an_excluded_drug_is_caught(self):
        state = await composed(medicine(name=f("Thyronorm 50"), strength=f("50 mcg")))
        medicine_out = state.rx_extraction.medicines[0]
        assert medicine_out.generic.reason_if_none == "not_substitutable"
        alt = GenericAlternative(
            drug_id="x", brand_name="Levothyroxine IP", is_janaushadhi=True, price_per_unit=0.1
        )
        forced = medicine_out.generic.model_copy(
            update={"alternatives": [alt], "reason_if_none": None}
        )
        assert "generic_not_substitutable" in await verified(self.tamper(state, generic=forced))

    async def test_a_suggestion_on_a_conflicting_match_is_caught(self):
        state = await composed(medicine(name=f("Dolo 650"), strength=f("500 mg", 0.9)))
        out = state.rx_extraction.medicines[0]
        assert out.match.strength_conflict
        alt = GenericAlternative(
            drug_id="x", brand_name="Paracetamol IP", is_janaushadhi=True, price_per_unit=0.1
        )
        forced = GenericSuggestion(alternatives=[alt])
        assert "generic_unsafe_match" in await verified(self.tamper(state, generic=forced))

    async def test_a_suggestion_without_a_match_or_catalog_is_caught(self):
        state = await composed(medicine())
        alt = GenericAlternative(
            drug_id="x", brand_name="Paracetamol IP", is_janaushadhi=True, price_per_unit=0.1
        )
        forced = GenericSuggestion(alternatives=[alt])
        assert "generic_without_safe_match" in await verified(
            self.tamper(state, match=None, generic=forced)
        )
        ctx = make_ctx(FakeProvider(), catalog=None)
        assert "generic_without_catalog" in await collect_failures(
            self.tamper(state, generic=forced), ctx
        )


# ---------------------------------------------------------------------------- templates and fallback


class TestTemplateNodes:
    async def test_templates_renders_the_static_text_in_the_users_language(self):
        state = state_for(text_request("hi", "hi"), template_key="greeting", intent=Intent.greeting)
        update, _ = await call(templates, state)
        assert "नमस्ते" in update["reply"].text and update["reply_source"] == "template"

    async def test_templates_carries_the_emergency_text(self):
        state = state_for(
            text_request("x"), template_key="emergency.general", intent=Intent.emergency
        )
        update, _ = await call(templates, state)
        assert "112" in update["reply"].text and update["intent"] is Intent.emergency

    async def test_the_fallback_renders_the_same_data_without_the_llm_lines(self):
        state = await composed(medicine())
        failed = state.model_copy(
            update={"verification": VerificationResult(ok=False, failures=["unknown_word"])}
        )
        update, _ = await call(rx_fallback_renderer, failed, catalog=seeded_catalog())
        assert (
            update["reply_source"] == "template"
            and "Dolo 650 (tablet, 650 mg) — 1 tablet" in update["reply"].text
        )
        assert update["errors"][0].code == "unknown_word"

    async def test_the_fallback_drops_suggestions_that_failed_their_recheck(self):
        state = await composed(medicine())
        assert "💰" in state.reply.text
        failed = state.model_copy(
            update={"verification": VerificationResult(ok=False, failures=["generic_four_key"])}
        )
        update, _ = await call(rx_fallback_renderer, failed, catalog=seeded_catalog())
        assert "💰" not in update["reply"].text
        assert update["rx_extraction"].medicines[0].generic is None
