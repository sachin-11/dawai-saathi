"""The interaction branches of the graph (M11): prescription + stored medicines, typed questions,
database failure, unmatched brands and the emergency guard that still comes first."""

from typing import Any

import pytest

from app.interactions.repository import FailingInteractionRepository
from app.interactions.service import InteractionService
from app.llm.fake import FakeProvider
from app.schemas.process import Intent, ProcessRequest
from tests.graph_support import nodes_run, run_graph, seeded_catalog, text_request
from tests.interaction_support import core_service, with_context
from tests.rx_support import (
    CLASSIFY_RX,
    extraction,
    f,
    fake_fetch,
    image_request,
    medicine,
    sample_jpeg,
)


@pytest.fixture(autouse=True)
def _jpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.tools.image_input.fetch_media", fake_fetch(sample_jpeg(), "image/jpeg")
    )


DOLO = medicine()
WARFARIN_STORED = {
    "salt": "warfarin",
    "strength": "5 mg",
    "medication_id": "11111111-1111-1111-1111-111111111111",
    "name": "Uniwarfin 5",
    "salt_key": "warfarin",
    "strength_key": "5mg",
}
CROCIN_STORED = {
    "salt": "paracetamol",
    "strength": "500 mg",
    "medication_id": "22222222-2222-2222-2222-222222222222",
    "name": "Crocin 500",
    "salt_key": "paracetamol",
    "strength_key": "500mg",
}


def lines(*names: str) -> dict[str, Any]:
    return {
        "items": [
            {"index": i, "text": f"{name} — 1 tablet, morning and night"}
            for i, name in enumerate(names, 1)
        ]
    }


async def ask(text: str, *, language="en", active=None, service=None, script=None):
    request = text_request(text, language)
    if active:
        request = with_context(request, active)
    return await run_graph(
        FakeProvider(script or []),
        request,
        seeded_catalog(),
        service if service is not None else core_service(),
    )


class TestTypedQuestion:
    async def test_dolo_and_combiflam_share_paracetamol(self):
        output, _ = await ask("Dolo aur Combiflam saath le sakte hain?")
        assert output.intent is Intent.interaction_query
        assert nodes_run(output) == [
            "emergency_guard", "redact", "emergency_classifier", "classify",
            "extract_interaction_query", "match_query_medicines", "interaction_check",
            "composer", "verifier",
        ]  # fmt: skip
        assert "You asked about: Dolo and Combiflam" in output.reply.text
        assert "both contain paracetamol" in output.reply.text
        assert "too much of the same medicine" in output.reply.text
        assert output.reply.buttons == []
        assert output.interactions is not None
        (finding,) = output.interactions.findings
        assert finding.type == "duplicate_ingredient"
        assert [w.type.value for w in output.warnings] == ["duplicate_ingredient"]
        assert output.warnings[0].detail == "paracetamol+paracetamol:duplicate"

    async def test_the_same_question_in_hindi(self):
        output, _ = await ask("Dolo aur Combiflam saath le sakte hain?", language="hi")
        assert "आपने इनके बारे में पूछा" in output.reply.text
        assert "दोनों में एक ही दवाई (paracetamol)" in output.reply.text

    async def test_a_known_major_pair_by_brand_and_by_salt_name(self):
        output, _ = await ask("Brufen aur Warfarin saath le sakte hain?")
        assert "⚠️ Important:" in output.reply.text
        assert "can increase the risk of bleeding" in output.reply.text
        (finding,) = output.interactions.findings
        assert (finding.salt_a, finding.salt_b, finding.severity) == (
            "ibuprofen",
            "warfarin",
            "major",
        )
        assert finding.interaction_id and finding.effect_code == "bleeding"
        assert output.warnings[0].detail == "ibuprofen+warfarin:major"

    async def test_no_known_pair_is_not_a_safety_claim(self):
        output, _ = await ask("Dolo aur Pantop saath le sakte hain?")
        text = output.reply.text
        assert "no known interaction" in text and "does not mean there is none" in text
        assert "safe" not in text.lower()
        assert output.interactions.findings == []

    async def test_an_unmatched_brand_is_reported_and_not_called_safe(self):
        output, _ = await ask("Zzqxfoo aur Dolo 650 saath le sakte hain?")
        text = output.reply.text
        assert "Zzqxfoo" in text and "does not mean they are safe" in text
        assert "no known interaction" not in text  # only one medicine could be checked
        assert [u.label for u in output.interactions.unchecked] == ["Zzqxfoo"]

    async def test_one_name_is_compared_with_the_stored_medicines(self):
        output, _ = await ask("Brufen saath le sakte hain?", active=[WARFARIN_STORED])
        assert "⚠️ Important:" in output.reply.text and "Uniwarfin 5" in output.reply.text

    async def test_one_name_and_nothing_stored_asks_for_a_second_name(self):
        output, _ = await ask("Brufen saath le sakte hain?")
        assert nodes_run(output)[-2:] == ["extract_interaction_query", "templates"]
        assert "Which medicines do you want to check" in output.reply.text

    async def test_stored_pairs_are_not_announced_again(self):
        stored = [WARFARIN_STORED, {**WARFARIN_STORED, "medication_id": "3", "name": "Brufen",
                                    "salt": "ibuprofen", "salt_key": "ibuprofen"}]  # fmt: skip
        output, _ = await ask("Dolo aur Pantop saath le sakte hain?", active=stored)
        assert "Important" not in output.reply.text

    async def test_the_database_down_says_so_and_never_none_found(self):
        output, _ = await ask(
            "Dolo aur Combiflam saath le sakte hain?",
            service=InteractionService(FailingInteractionRepository()),
        )
        assert "could not check for interactions" in output.reply.text
        assert "no known interaction" not in output.reply.text
        assert output.interactions.database_ok is False

    async def test_without_the_service_the_old_placeholder_is_kept(self):
        request = text_request("Dolo aur Combiflam saath le sakte hain?")
        output, _ = await run_graph(FakeProvider([]), request, seeded_catalog(), None)
        assert output.reply.text.startswith("Thanks for your message")

    async def test_the_reply_always_ends_with_the_disclaimer(self):
        output, _ = await ask("Brufen aur Warfarin saath le sakte hain?")
        assert output.reply.text.rstrip().endswith("before acting on this.")

    async def test_the_extraction_model_only_sees_the_redacted_text(self):
        provider = FakeProvider([])
        request = text_request("Dolo aur Combiflam saath le sakte hain? call 9876543210")
        await run_graph(provider, request, seeded_catalog(), core_service())
        sent = [
            m.content
            for call in provider.calls
            if call["response_model"] and "medicine_names" in call["response_model"].model_fields
            for m in call["messages"]
        ]
        assert sent and not any("9876543210" in text for text in sent)


class TestEmergencyStillFirst:
    async def test_an_emergency_never_reaches_the_interaction_nodes(self):
        output, _ = await ask(
            "maine Dolo aur Combiflam saath le li aur seene me dard ho raha hai",
        )
        assert output.emergency is True and output.intent is Intent.emergency
        assert nodes_run(output) == ["emergency_guard", "templates"]
        assert output.interactions is None
        assert "112" in output.reply.text

    async def test_a_classifier_emergency_stops_before_the_question_is_classified(self):
        output, _ = await ask(
            "maine Dolo aur Combiflam saath le li, chakkar aa raha hai",
            script=[{"is_emergency": True, "category": "unconscious", "confidence": 0.9}],
        )
        path = nodes_run(output)
        assert path[:3] == ["emergency_guard", "redact", "emergency_classifier"]
        if output.emergency:  # the rules or the classifier caught it: no interaction node ran
            assert "extract_interaction_query" not in path and "interaction_check" not in path


class TestPrescription:
    def request(self, active=None, language="en") -> ProcessRequest:
        request = image_request(language)
        return with_context(request, active) if active else request

    async def run(self, extraction_json, active=None, language="en", names=("Dolo 650",)):
        return await run_graph(
            FakeProvider([CLASSIFY_RX, extraction_json, lines(*names)]),
            self.request(active, language),
            seeded_catalog(),
            core_service(),
        )

    async def test_a_second_paracetamol_from_another_doctor_is_flagged(self):
        output, _ = await self.run(extraction(DOLO), active=[CROCIN_STORED])
        assert nodes_run(output)[-5:] == [
            "generic_finder", "interaction_check", "confidence_gate", "composer", "verifier",
        ]  # fmt: skip
        text = output.reply.text
        assert "Dolo 650 and Crocin 500 both contain paracetamol" in text
        assert "too much of the same medicine" in text
        (finding,) = output.interactions.findings
        assert finding.medication_refs == ["rx:0", CROCIN_STORED["medication_id"]]
        assert any(w.type.value == "duplicate_ingredient" for w in output.warnings)

    async def test_the_main_reply_keeps_its_three_buttons(self):
        output, _ = await self.run(extraction(DOLO), active=[CROCIN_STORED])
        assert [b.id.split(":")[1] for b in output.reply.buttons] == [
            "reminders",
            "generic",
            "wrong",
        ]

    async def test_a_major_pair_with_a_stored_medicine(self):
        ibuprofen = medicine(
            raw_text=f("Tab. Ibuprofen 400 mg"),
            name=f("Ibuprofen"),
            strength=f("400 mg"),
        )
        output, _ = await self.run(
            extraction(ibuprofen), active=[WARFARIN_STORED], names=("Ibuprofen",)
        )
        text = output.reply.text
        assert "⚠️ Important:" in text and "Ibuprofen and Uniwarfin 5" in text
        assert text.index("Ibuprofen —") < text.index("Important:")  # the medicine list comes first
        assert text.rstrip().endswith("before acting on this.")

    async def test_hindi_reply(self):
        output, _ = await self.run(extraction(DOLO), active=[CROCIN_STORED], language="hi")
        assert "दोनों में एक ही दवाई (paracetamol)" in output.reply.text

    async def test_with_no_stored_medicine_a_single_medicine_adds_no_interaction_text(self):
        output, _ = await self.run(extraction(DOLO))
        assert "interaction" not in output.reply.text.lower()
        assert "paracetamol" not in output.reply.text
        assert output.interactions is not None and output.interactions.findings == []

    async def test_a_stored_medicine_without_a_salt_is_listed_as_not_checked(self):
        unknown = {**CROCIN_STORED, "salt_key": None, "name": "Mystery Syrup"}
        output, _ = await self.run(extraction(DOLO), active=[unknown])
        assert "Mystery Syrup" in output.reply.text
        assert "does not mean they are safe" in output.reply.text
        assert "no known interaction" not in output.reply.text

    async def test_two_new_medicines_with_no_pair_say_nothing_was_found_not_safe(self):
        pantop = medicine(
            raw_text=f("Tab. Pantop 40"), name=f("Pantop 40"), strength=f("40 mg"),
            frequency_code=f("1-0-0"), frequency_per_day=f(1), timings=f(["morning"], 0.9),
        )  # fmt: skip
        output, _ = await self.run(extraction(DOLO, pantop), names=("Dolo 650", "Pantop 40"))
        assert "no known interaction" in output.reply.text
        assert "safe" not in output.reply.text.lower().replace("not safe", "")

    async def test_an_unreadable_medicine_is_not_checked_or_called_safe(self):
        unreadable = medicine(
            name=f(None, 0.2), strength=f(None, 0.2), dose=f(None, 0.2), frequency_code=f(None, 0.2),
            frequency_per_day=f(None, 0.2), raw_text=f("?", 0.2),
        )  # fmt: skip
        output, _ = await self.run(extraction(DOLO, unreadable), active=[CROCIN_STORED])
        assert (
            output.interactions.checked_count == 2
        )  # Dolo + stored Crocin; not the unreadable one
        assert "could not read" in output.reply.text

    async def test_resolved_salts_are_returned_for_the_gateway_to_store(self):
        output, _ = await self.run(extraction(DOLO), active=[CROCIN_STORED])
        assert [(r.ref, r.salt_key) for r in output.interactions.resolved] == [
            ("rx:0", "paracetamol")
        ]

    async def test_a_failed_read_returns_no_interaction_report(self):
        bad = medicine(name=f(None, 0.1), strength=f(None, 0.1), dose=f(None, 0.1),
                       frequency_code=f(None, 0.1), frequency_per_day=f(None, 0.1))  # fmt: skip
        output, _ = await run_graph(
            FakeProvider([CLASSIFY_RX, extraction(bad)]),
            self.request([CROCIN_STORED]),
            seeded_catalog(),
            core_service(),
        )
        assert output.interactions is None
