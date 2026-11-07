"""Presidio redaction with Indian recognisers (M6): positives, negatives, fail-closed, logs."""

import json
import logging
from pathlib import Path

import pytest
import structlog

from app.observability.logging import SENSITIVE_FIELDS, configure_logging, redact_sensitive_fields
from app.safety import redaction
from app.safety.redaction import (
    RedactionResult,
    Redactor,
    configure_redactor,
    get_redactor,
    redact_str,
    redact_text,
    redact_value,
    verhoeff_valid,
)

SAMPLES = json.loads(
    (Path(__file__).parents[3] / "packages/contracts/safety/redaction-samples.json").read_text(
        encoding="utf-8"
    )
)


@pytest.fixture(scope="module")
def redactor() -> Redactor:
    instance = Redactor()
    instance.warm_up()
    return instance


def types_of(result: RedactionResult) -> dict[str, int]:
    return {entity.type: entity.count for entity in result.entities}


class TestSharedFixtureWithTheGateway:
    @pytest.mark.parametrize("sample", SAMPLES["must_redact"], ids=lambda s: s["input"][:30])
    def test_every_secret_is_removed(self, redactor: Redactor, sample: dict) -> None:
        out = redactor.redact(sample["input"]).text
        for secret in sample["secrets"]:
            assert secret not in out

    @pytest.mark.parametrize("sample", SAMPLES["must_keep"], ids=lambda s: s["input"][:30])
    def test_medical_text_is_untouched(self, redactor: Redactor, sample: dict) -> None:
        result = redactor.redact(sample["input"])
        assert result.text == sample["input"] and result.entities == []


class TestIndianMobile:
    @pytest.mark.parametrize(
        "phone",
        [
            "9876543210",
            "98765 43210",
            "98765-43210",
            "9876 543 210",
            "+91 9876543210",
            "+91-98765-43210",
            "+919876543210",
            "919876543210",
            "91 98765 43210",
            "09876543210",
            "0091 9876543210",
            "6000000000",
            "7012345678",
        ],
    )
    def test_formats(self, redactor: Redactor, phone: str) -> None:
        result = redactor.redact(f"call {phone} now")
        assert result.text.startswith("call [") and result.text.endswith("] now")
        assert not any(char.isdigit() for char in result.text)

    @pytest.mark.parametrize("text", ["call 1234567890 now", "order 5876543210", "id 12345"])
    def test_numbers_that_are_not_mobiles_survive(self, redactor: Redactor, text: str) -> None:
        assert "[PHONE]" not in redactor.redact(text).text

    def test_a_plain_mobile_is_labelled_as_a_phone(self, redactor: Redactor) -> None:
        result = redactor.redact("call 9876543210 now")
        assert result.text == "call [PHONE] now"
        assert types_of(result) == {"IN_PHONE": 1}


class TestAadhaarLike:
    def test_spaced_and_plain_twelve_digits(self, redactor: Redactor) -> None:
        for number in ("2345 6789 0124", "2345-6789-0124", "234567890124"):
            assert redactor.redact(f"aadhaar {number}").text == "aadhaar [AADHAAR]"

    def test_verhoeff_checksum(self) -> None:
        assert verhoeff_valid("234567890124") is True
        assert verhoeff_valid("234567890125") is False
        assert verhoeff_valid("") is False

    def test_a_number_with_a_bad_checksum_is_still_redacted(self, redactor: Redactor) -> None:
        # over-redacting is the safe direction; the checksum only raises the confidence
        assert redactor.redact("id 2345 6789 0125").text == "id [AADHAAR]"

    def test_a_twelve_digit_number_starting_with_1_is_not_aadhaar(self, redactor: Redactor) -> None:
        assert "[AADHAAR]" not in redactor.redact("ref 1234 5678 9012").text


class TestOtherIdentifiers:
    def test_pan(self, redactor: Redactor) -> None:
        assert redactor.redact("PAN ABCDE1234F hai").text == "PAN [PAN] hai"
        assert "[PAN]" not in redactor.redact("code ABCDE12345").text

    def test_abha(self, redactor: Redactor) -> None:
        assert redactor.redact("ABHA 12-3456-7890-1234").text == "ABHA [ABHA]"
        assert redactor.redact("ABHA 12345678901234").text == "ABHA [ABHA]"

    @pytest.mark.parametrize(
        "text",
        [
            "pincode 400001",
            "PIN code: 560034",
            "my address is MG Road Pune 411001",
            "पिन 110001",
            "पता सेक्टर नोएडा 201301",
        ],
    )
    def test_pin_codes_need_a_context_word(self, redactor: Redactor, text: str) -> None:
        result = redactor.redact(text)
        assert "[PIN]" in result.text
        assert not any(char.isdigit() for char in result.text)

    @pytest.mark.parametrize(
        "text",
        [
            "platelets 150000",
            "wbc 11000 and platelets 250000",
            "creatinine 0.9 hb 12.5",
            "order 400001",
        ],
    )
    def test_six_digit_lab_values_are_not_pin_codes(self, redactor: Redactor, text: str) -> None:
        assert redactor.redact(text).text == text

    def test_email(self, redactor: Redactor) -> None:
        result = redactor.redact("write to a.b+c@mail.example.in today")
        assert result.text == "write to [EMAIL] today"

    def test_url_with_query_parameters_but_not_a_plain_link(self, redactor: Redactor) -> None:
        assert redactor.redact("see https://x.in/report?id=42&t=abc").text == "see [URL]"
        plain = "see https://www.who.int/news"
        assert redactor.redact(plain).text == plain

    @pytest.mark.parametrize(
        "text",
        ["UHID: AB-12345", "MRN 998877", "Reg No: R/2024/55", "IP No 55-1234", "OP no. 778899"],
    )
    def test_hospital_ids(self, redactor: Redactor, text: str) -> None:
        result = redactor.redact(text)
        assert "[HOSPITAL_ID]" in result.text and not any(c.isdigit() for c in result.text)


class TestNames:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Dr. Rajesh Kumar prescribed it", "Dr. [NAME] prescribed it"),
            ("Mrs Sunita Devi came", "Mrs [NAME] came"),
            ("Shri Ramesh Gupta ji", "Shri [NAME] ji"),
            ("Smt. Kavita", "Smt. [NAME]"),
            ("dr sharma ne kaha", "dr [NAME] ne kaha"),
            ("patient name: Anil Mehta", "patient name: [NAME]"),
            ("my name is Priya Nair", "my name is [NAME]"),
            ("mera naam ramesh kumar hai", "mera naam [NAME] hai"),
            ("डॉ शर्मा ने कहा", "डॉ [NAME] ने कहा"),
            ("मेरा नाम सुनीता है", "मेरा नाम [NAME] है"),
        ],
    )
    def test_names_after_a_context_word(self, redactor: Redactor, text: str, expected: str) -> None:
        assert redactor.redact(text).text == expected

    @pytest.mark.parametrize(
        "text",
        [
            "Metformin 500 mg 1-0-1",
            "Dolo 650 and Pantoprazole 40",
            "dawai ka naam paracetamol hai",
            "doctor ne kaha subah leni hai",
            "Dr ka parcha hai",
            "Augmentin 625 Duo BD",
        ],
    )
    def test_drug_names_and_plain_words_are_never_names(
        self, redactor: Redactor, text: str
    ) -> None:
        # spaCy tags "Metformin" as a PERSON; the context gate must stop that
        assert redactor.redact(text).text == text


class TestMedicalContentIsNeverRedacted:
    @pytest.mark.parametrize(
        "text",
        [
            "Tab Metformin 500 mg 1-0-1 after food for 30 days",
            "Dolo 650 BD",
            "Paracetamol 650 TDS x 5 days",
            "Amoxicillin 500mg 1-1-1",
            "HbA1c 7.2 %",
            "TSH 4.5 mIU/L",
            "Hb 11.8 g/dL, platelets 150000, creatinine 1.1",
            "BP 130/80, sugar fasting 112",
            "prescribed on 12/03/2026, review after 2 weeks",
            "Insulin 10 units at night, Telmisartan 40 mg OD",
            "1-0-1 BD TDS QID SOS HS",
        ],
    )
    def test_doses_schedules_lab_values_and_dates_survive(
        self, redactor: Redactor, text: str
    ) -> None:
        result = redactor.redact(text)
        assert result.text == text
        assert result.entities == []


class TestResult:
    def test_reports_types_and_counts_never_values(self, redactor: Redactor) -> None:
        result = redactor.redact("9876543210 and 9123456780, mail a@b.co")
        assert types_of(result) == {"EMAIL_ADDRESS": 1, "IN_PHONE": 2}
        assert "9876543210" not in repr(result.entities)

    def test_is_idempotent(self, redactor: Redactor) -> None:
        once = redactor.redact("call 9876543210, mail a@b.co, Dr Sharma").text
        assert redactor.redact(once).text == once

    def test_blank_text_is_returned_as_is(self, redactor: Redactor) -> None:
        assert redactor.redact("   ").text == "   "
        assert redactor.redact("").entities == []

    def test_a_disabled_redactor_passes_text_through(self) -> None:
        assert Redactor(enabled=False).redact("9876543210").text == "9876543210"


class TestFailClosed:
    def test_if_the_engines_break_a_regex_layer_still_removes_identifiers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def boom() -> object:
            raise RuntimeError("model missing: SECRET 9876543210")

        monkeypatch.setattr(redaction, "_build_engines", boom)
        result = Redactor().redact("call 9876543210, a@b.co, aadhaar 2345 6789 0124, pin 400001")
        for secret in ("9876543210", "a@b.co", "2345 6789 0124", "400001"):
            assert secret not in result.text

    def test_the_failure_is_logged_without_the_text(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        def boom() -> object:
            raise RuntimeError("SECRET 9876543210")

        monkeypatch.setattr(redaction, "_build_engines", boom)
        configure_logging("info")
        Redactor().redact("call 9876543210")
        out = capsys.readouterr().out
        assert "redaction_engine_failed" in out and "RuntimeError" in out
        assert "9876543210" not in out and "SECRET" not in out


class TestModuleApi:
    def test_redact_text_returns_a_result_and_redact_str_the_string(
        self, redactor: Redactor
    ) -> None:
        previous = get_redactor()
        configure_redactor(redactor)
        try:
            assert redact_text("call 9876543210").text == "call [PHONE]"
            assert redact_str("call 9876543210") == "call [PHONE]"
        finally:
            configure_redactor(previous)

    def test_redact_value_walks_nested_structures(self, redactor: Redactor) -> None:
        previous = get_redactor()
        configure_redactor(redactor)
        try:
            data = {"a": ["call 9876543210", {"b": "x@y.com"}], "n": 5, "t": ("mail a@b.co",)}
            assert redact_value(data) == {
                "a": ["call [PHONE]", {"b": "[EMAIL]"}],
                "n": 5,
                "t": ["mail [EMAIL]"],
            }
        finally:
            configure_redactor(previous)

    def test_redact_value_stops_at_absurd_depth(self) -> None:
        nested: object = "9876543210"
        for _ in range(20):
            nested = [nested]
        assert "9876543210" not in json.dumps(redact_value(nested))


class TestLogging:
    def test_the_processor_redacts_text_body_prompt_and_output_fields(self) -> None:
        event = {
            "event": "x",
            "text": "call 9876543210",
            "body": "mail a@b.co",
            "prompt": [{"content": "aadhaar 2345 6789 0124"}],
            "output": {"reply": "PAN ABCDE1234F"},
            "latency_ms": 12,
            "model": "m",
        }
        out = redact_sensitive_fields(None, "info", dict(event))
        dump = json.dumps(out)
        for secret in ("9876543210", "a@b.co", "2345 6789 0124", "ABCDE1234F"):
            assert secret not in dump
        assert out["latency_ms"] == 12 and out["model"] == "m"
        assert {"text", "body", "prompt", "output"} == SENSITIVE_FIELDS

    def test_a_real_log_line_never_contains_the_phone_number(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        configure_logging("info")
        structlog.get_logger("t").info("debug", text="call me on 9876543210", user_id="u1")
        logging.getLogger("stdlib").info("plain stdlib line")
        out = capsys.readouterr().out
        assert "9876543210" not in out and "[PHONE]" in out and "u1" in out


class TestPerformance:
    def test_a_typical_message_is_fast_enough_for_the_request_path(
        self, redactor: Redactor
    ) -> None:
        import time

        text = "mera naam ramesh hai, call 9876543210, Dolo 650 BD"
        redactor.redact(text)  # warm
        started = time.perf_counter()
        for _ in range(10):
            redactor.redact(text)
        assert (time.perf_counter() - started) / 10 < 0.1
