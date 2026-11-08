"""The LangGraph pipeline (M9): same behaviour as the pre-graph pipeline, branch by branch.

PARITY: every scenario runs through `RxPipeline(MinimalPipeline())` (the rollback path) and through
`GraphPipeline()` with identical inputs and scripted fake models; the user-visible output (reply text,
buttons, intent, emergency flag and category, warnings, the stored extraction) must be EQUAL.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, ClassVar

import pytest

from app.llm.fake import FakeProvider
from app.pipeline.minimal import MinimalPipeline
from app.pipeline.rx import RxPipeline
from app.schemas.process import Intent, ProcessRequest
from tests.graph_support import (
    NOT_EMERGENCY,
    audio_request,
    nodes_run,
    run_graph,
    seeded_catalog,
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


@pytest.fixture(autouse=True)
def _jpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
    )


def lines(*names: str) -> dict[str, Any]:
    return {
        "items": [
            {"index": i, "text": f"{name} — 1 tablet, morning and night"}
            for i, name in enumerate(names, 1)
        ]
    }


def lie(index: int = 1) -> dict[str, Any]:
    return {"items": [{"index": index, "text": "Dolo 650 — 1 tablet, also take Crocin"}]}


@dataclass(frozen=True)
class Scenario:
    id: str
    request: Callable[[], ProcessRequest]
    script: Callable[[], list[Any]]
    catalog: bool = True


DOLO, PANTOP = (
    medicine(),
    medicine(
        name=f("Pantop 40"), frequency_code=f("OD"), frequency_per_day=f(1), timings=f(None, 0.0)
    ),
)
UNREADABLE = medicine(name=f(None, 0.1))

SCENARIOS = [
    Scenario("help", lambda: text_request("kya kar sakte ho?"), lambda: [NOT_EMERGENCY]),
    Scenario("greeting", lambda: text_request("hello"), lambda: []),
    Scenario("out_of_scope", lambda: text_request("cricket score batao"), lambda: []),
    Scenario("hindi_user", lambda: text_request("hello", "hi"), lambda: []),
    Scenario(
        "emergency_rules", lambda: text_request("seene me bahut dard ho raha hai"), lambda: []
    ),
    Scenario("self_harm", lambda: text_request("mujhe jeena nahi hai", "hi"), lambda: []),
    Scenario(
        "emergency_classifier",
        lambda: text_request("meri maa ka chehra ek taraf latak gaya hai"),
        lambda: [{"is_emergency": True, "category": "stroke", "confidence": 0.9}],
    ),
    Scenario("lab_text", lambda: text_request("meri blood test report samjhao"), lambda: []),
    Scenario(
        "interaction_text", lambda: text_request("do dawai saath me le sakta hoon?"), lambda: []
    ),
    Scenario("generic_query", lambda: text_request("Dolo 650 ka generic batao"), lambda: []),
    Scenario(
        "generic_query_salt",
        lambda: text_request("paracetamol 500 mg ka generic batao"),
        lambda: [],
    ),
    Scenario(
        "generic_query_nti", lambda: text_request("Thyronorm 50 mcg ka generic batao"), lambda: []
    ),
    Scenario("generic_query_unknown", lambda: text_request("Zzxq 10 ka generic batao"), lambda: []),
    Scenario("generic_query_no_name", lambda: text_request("generic batao"), lambda: []),
    Scenario(
        "generic_query_no_catalog",
        lambda: text_request("Dolo 650 ka generic batao"),
        lambda: [],
        catalog=False,
    ),
    Scenario("audio", audio_request, lambda: []),
    Scenario(
        "rx_happy",
        image_request,
        lambda: [CLASSIFY_RX, extraction(DOLO, PANTOP), lines("Dolo 650", "Pantop 40")],
    ),
    Scenario(
        "rx_happy_hindi",
        lambda: image_request("hi"),
        lambda: [CLASSIFY_RX, extraction(DOLO), lines("Dolo 650")],
    ),
    Scenario(
        "rx_no_catalog",
        image_request,
        lambda: [CLASSIFY_RX, extraction(DOLO), lines("Dolo 650")],
        catalog=False,
    ),
    Scenario(
        "rx_low_confidence",
        image_request,
        lambda: [CLASSIFY_RX, extraction(DOLO, UNREADABLE), lines("Dolo 650")],
    ),
    Scenario("rx_all_unreadable", image_request, lambda: [CLASSIFY_RX, extraction(UNREADABLE)]),
    Scenario(
        "rx_unclear_dose",
        image_request,
        lambda: [
            CLASSIFY_RX,
            extraction(DOLO, medicine(name=f("Cetzine"), dose=f(None, 0.0))),
            lines("Dolo 650"),
        ],
    ),
    Scenario(
        "rx_excluded_drug",
        image_request,
        lambda: [
            CLASSIFY_RX,
            extraction(medicine(name=f("Glycomet SR 500"), strength=f("500 mg", 0.9))),
            lines("Glycomet SR 500"),
        ],
    ),
    Scenario(
        "rx_not_a_prescription",
        image_request,
        lambda: [CLASSIFY_RX, extraction(DOLO, is_prescription=False)],
    ),
    Scenario(
        "rx_unreadable_image",
        image_request,
        lambda: [CLASSIFY_RX, extraction(DOLO, image_quality="unreadable")],
    ),
    Scenario(
        "rx_llm_line_invents_a_medicine",
        image_request,
        lambda: [CLASSIFY_RX, extraction(DOLO), lie()],
    ),
    Scenario(
        "rx_composer_fails", image_request, lambda: [CLASSIFY_RX, extraction(DOLO)]
    ),  # script ends: default fake composes
    Scenario(
        "lab_image",
        image_request,
        lambda: [{"kind": "lab_report", "quality": "good", "confidence": 0.9}],
    ),
    Scenario(
        "strip_image",
        image_request,
        lambda: [{"kind": "medicine_strip", "quality": "good", "confidence": 0.9}],
    ),
    Scenario(
        "other_image",
        image_request,
        lambda: [{"kind": "other", "quality": "good", "confidence": 0.9}],
    ),
    Scenario(
        "unsure_image",
        image_request,
        lambda: [{"kind": "prescription", "quality": "good", "confidence": 0.2}],
    ),
    Scenario(
        "unreadable_by_model",
        image_request,
        lambda: [{"kind": "prescription", "quality": "unreadable", "confidence": 0.9}],
    ),
]


def comparable(output) -> dict[str, Any]:
    return {
        "intent": output.intent,
        "emergency": output.emergency,
        "category": output.emergency_category,
        "text": output.reply.text,
        "buttons": [(b.id, b.title) for b in output.reply.buttons],
        "warnings": [(w.type, w.detail) for w in output.warnings],
        "extraction": output.extraction.model_dump(mode="json") if output.extraction else None,
    }


class TestParityWithThePreGraphPipeline:
    @pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.id)
    async def test_same_user_visible_output(self, scenario: Scenario):
        catalog = seeded_catalog() if scenario.catalog else None
        before_ctx = make_ctx(FakeProvider(scenario.script()), catalog=catalog)
        before = await RxPipeline(MinimalPipeline()).run(scenario.request(), before_ctx)
        after, after_ctx = await run_graph(
            FakeProvider(scenario.script()), scenario.request(), catalog
        )

        assert comparable(after) == comparable(before)
        # The request's accounting agrees too: what was spent and which prompts ran.
        assert after_ctx.usage.cost_usd == pytest.approx(before_ctx.usage.cost_usd)
        assert after_ctx.usage.prompt_versions == before_ctx.usage.prompt_versions

    async def test_the_scenarios_cover_every_intent_of_the_contract_the_pipeline_can_produce(self):
        produced = set()
        for scenario in SCENARIOS:
            catalog = seeded_catalog() if scenario.catalog else None
            output, _ = await run_graph(
                FakeProvider(scenario.script()), scenario.request(), catalog
            )
            produced.add(output.intent)
        assert produced >= {
            Intent.help, Intent.greeting, Intent.out_of_scope, Intent.emergency, Intent.prescription,
            Intent.lab_report, Intent.interaction_query, Intent.generic_query, Intent.other,
        }  # fmt: skip


class TestBranches:
    """Which nodes ran, per branch (the path through the graph)."""

    async def path(
        self, request: ProcessRequest, script: list[Any], catalog: bool = True
    ) -> list[str]:
        output, _ = await run_graph(
            FakeProvider(script), request, seeded_catalog() if catalog else None
        )
        return nodes_run(output)

    async def test_emergency_text_stops_at_the_first_node(self):
        assert await self.path(text_request("seene me dard ho raha hai"), []) == [
            "emergency_guard",
            "templates",
        ]

    async def test_a_classifier_emergency_stops_before_classify(self):
        path = await self.path(
            text_request("meri maa ka chehra ek taraf latak gaya hai"),
            [{"is_emergency": True, "category": "stroke", "confidence": 0.9}],
        )
        assert path == ["emergency_guard", "redact", "emergency_classifier", "templates"]

    @pytest.mark.parametrize(
        "text",
        ["kya kar sakte ho?", "hello", "cricket score batao", "meri blood test report samjhao"],
    )
    async def test_simple_text_intents(self, text):
        assert await self.path(text_request(text), []) == [
            "emergency_guard", "redact", "emergency_classifier", "classify", "templates",
        ]  # fmt: skip

    async def test_audio_is_a_placeholder(self):
        assert await self.path(audio_request(), []) == ["transcribe", "templates"]

    async def test_a_prescription_goes_through_the_whole_chain_then_the_verifier(self):
        path = await self.path(image_request(), [CLASSIFY_RX, extraction(DOLO), lines("Dolo 650")])
        assert path == [
            "prepare_image", "classify", "vision_extract_rx", "validate_rx", "normalize_drugs",
            "generic_finder", "interaction_check", "confidence_gate", "composer", "verifier",
        ]  # fmt: skip

    async def test_the_typed_generic_query_skips_the_gate(self):
        path = await self.path(text_request("Dolo 650 ka generic batao"), [])
        assert path == [
            "emergency_guard", "redact", "emergency_classifier", "classify", "extract_query",
            "normalize_drugs", "generic_finder", "composer", "verifier",
        ]  # fmt: skip

    async def test_an_unreadable_prescription_stops_at_the_gate(self):
        path = await self.path(image_request(), [CLASSIFY_RX, extraction(UNREADABLE)])
        assert path[-2:] == ["confidence_gate", "templates"]

    async def test_a_lab_report_photo_is_a_placeholder_branch(self):
        path = await self.path(
            image_request(), [{"kind": "lab_report", "quality": "good", "confidence": 0.9}]
        )
        assert path == ["prepare_image", "classify", "templates"]

    async def test_a_hopeless_photo_never_reaches_a_model(self, monkeypatch):
        import io

        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (800, 800), (8, 8, 8)).save(buffer, format="JPEG")
        monkeypatch.setattr(
            "app.tools.image_input.fetch_media", fake_fetch(buffer.getvalue(), "image/jpeg")
        )
        provider = FakeProvider()
        output, _ = await run_graph(provider, image_request(), seeded_catalog())
        assert nodes_run(output) == ["prepare_image", "templates"] and provider.calls == []
        assert "too dark" in output.reply.text

    async def test_the_verifier_failure_goes_to_the_fallback_renderer(self):
        path = await self.path(image_request(), [CLASSIFY_RX, extraction(DOLO), lie()])
        assert path[-3:] == ["composer", "verifier", "rx_fallback"]


class TestTheEmergencyRuleOnImages:
    async def test_text_read_from_an_image_never_reaches_the_emergency_guard(self):
        """A prescription that says "chest pain" is history, not a message from the user (§2.2)."""
        history = medicine(instructions=f("for chest pain and breathlessness, call 112", 0.9))
        provider = FakeProvider([CLASSIFY_RX, extraction(history), lines("Dolo 650")])
        output, _ = await run_graph(provider, image_request(), seeded_catalog())
        assert not output.emergency and output.intent is Intent.prescription
        assert not {"emergency_guard", "redact", "emergency_classifier"} & set(nodes_run(output))
        names = [call["response_model"].__name__ for call in provider.calls]
        assert "EmergencyClassification" not in names

    async def test_the_same_words_typed_by_the_user_are_an_emergency(self):
        output, _ = await run_graph(
            FakeProvider(), text_request("seene me dard aur saans nahi aa rahi"), None
        )
        assert output.emergency and output.intent is Intent.emergency


class TestRetryAndResilience:
    BAD: ClassVar[dict[str, int]] = {"nonsense": 1}

    async def test_a_first_invalid_answer_is_retried_once_and_can_succeed(self):
        # first attempt: invalid + the router's own repair invalid; retry (strict prompt): valid
        script = [CLASSIFY_RX, self.BAD, self.BAD, extraction(DOLO), lines("Dolo 650")]
        output, ctx = await run_graph(FakeProvider(script), image_request(), seeded_catalog())
        assert output.intent is Intent.prescription and "Dolo 650" in output.reply.text
        assert nodes_run(output).count("vision_extract_rx") == 2
        assert {"rx_extract_v1", "rx_extract_strict_v1"} <= set(ctx.usage.prompt_versions)

    async def test_two_invalid_rounds_end_in_needs_review_after_exactly_one_retry(self):
        provider = FakeProvider([CLASSIFY_RX, *[self.BAD] * 10])
        output, _ = await run_graph(provider, image_request(), seeded_catalog())
        assert output.extraction is not None and output.extraction.status == "needs_review"
        assert "will not guess" in output.reply.text
        vision_calls = [
            c for c in provider.calls if c["response_model"].__name__ == "PrescriptionExtraction"
        ]
        assert (
            len(vision_calls) == 4
        )  # (call + repair) x (first attempt + the single retry): never more
        assert nodes_run(output).count("vision_extract_rx") == 2
        assert [w.type.value for w in output.warnings] == ["low_confidence"]

    async def test_a_failing_composer_still_answers_from_the_template(self):
        from app.llm.types import LLMServerError

        script = [CLASSIFY_RX, extraction(DOLO), LLMServerError(), LLMServerError()]
        output, _ = await run_graph(FakeProvider(script), image_request(), seeded_catalog())
        assert "Dolo 650 (tablet, 650 mg)" in output.reply.text
        assert [t.status for t in output.debug_trace or [] if t.node == "composer"] == ["fallback"]
