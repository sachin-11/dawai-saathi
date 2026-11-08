"""Render generic-medicine details from structured data only (M8, CLAUDE.md §2.4 and §2.5).

No language model writes any of this: the text comes from `generic_details.{hi,en}.j2` and
`generic_none.{hi,en}.j2`, filled with the matcher / finder output. A deterministic verifier then
checks the finished text: every rupee amount and every alternative's name must exist in the data.
"""

import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Final

import structlog
from jinja2 import StrictUndefined
from jinja2.sandbox import SandboxedEnvironment

from app.prompts.registry import TEMPLATE_DIR
from app.safety.disclaimers import add_disclaimer
from app.schemas.catalog import GenericAlternative, GenericSuggestion, NoGenericReason
from app.schemas.process import Language

log = structlog.get_logger("generic_render")
GENERIC_TEMPLATE_VERSION: Final = "generic_reply_v1"

_ENV = SandboxedEnvironment(
    undefined=StrictUndefined, autoescape=False, keep_trailing_newline=False
)

_REASONS: Final[dict[Language, dict[str, str]]] = {
    Language.en: {
        "low_confidence": "I could not read this clearly enough to compare.",
        "no_match": "I could not find it in my medicine list.",
        "weak_match": "I am not sure which product this is.",
        "strength_mismatch": "The strength on the prescription differs from the product I found.",
        "form_mismatch": "The form on the prescription differs from the product I found.",
        "strength_unverified": "The strength is not clear, so I cannot compare safely.",
        "ambiguous": "More than one product with different strengths fits this name.",
        "not_substitutable": "This kind of medicine should not be swapped without your doctor.",
        "no_exact_alternative": "I found no product with exactly the same salt, strength and form.",
        "no_cheaper_option": "No cheaper option with the same salt was found.",
    },
    Language.hi: {
        "low_confidence": "इसे इतना साफ़ नहीं पढ़ा जा सका कि तुलना हो सके।",
        "no_match": "यह मेरी दवाइयों की सूची में नहीं मिली।",
        "weak_match": "मुझे पक्का नहीं कि यह कौन-सा प्रोडक्ट है।",
        "strength_mismatch": "पर्ची में लिखी स्ट्रेंथ मिले हुए प्रोडक्ट से अलग है।",
        "form_mismatch": "पर्ची में लिखा रूप (गोली/सिरप) मिले हुए प्रोडक्ट से अलग है।",
        "strength_unverified": "स्ट्रेंथ साफ़ नहीं है, इसलिए सुरक्षित तुलना नहीं हो सकती।",
        "ambiguous": "इस नाम से अलग-अलग स्ट्रेंथ के एक से ज़्यादा प्रोडक्ट मेल खाते हैं।",
        "not_substitutable": "इस तरह की दवाई डॉक्टर से पूछे बिना नहीं बदलनी चाहिए।",
        "no_exact_alternative": "ठीक वही साल्ट, स्ट्रेंथ और रूप वाला कोई प्रोडक्ट नहीं मिला।",
        "no_cheaper_option": "उसी साल्ट का कोई सस्ता विकल्प नहीं मिला।",
    },
}


@dataclass(frozen=True, slots=True)
class DetailItem:
    number: int
    name: str
    strength: str | None
    generic: GenericSuggestion | None


def rupees(value: float) -> str:
    """12.0 -> "12", 12.5 -> "12.50": the one formatting both the text and the verifier use."""
    return f"{int(value)}" if float(value).is_integer() else f"{value:.2f}"


def _date_text(value: date | None) -> str | None:
    return value.strftime("%d-%m-%Y") if value else None


def _price_text(alt: GenericAlternative, language: Language) -> str:
    if alt.pack_price is not None and alt.pack_label:
        return f"₹{rupees(alt.pack_price)} ({alt.pack_label})"
    per = "प्रति नग" if language is Language.hi else "per unit"
    return f"₹{rupees(alt.price_per_unit)} {per}"


def _saving_text(alt: GenericAlternative, language: Language) -> str | None:
    if alt.approx_savings is None:
        return None
    if language is Language.hi:
        scope = "पूरे कोर्स में" if alt.savings_basis == "course" else "एक पैक पर"
        return f"{scope} लगभग ₹{alt.approx_savings} बचत"
    scope = "for the whole course" if alt.savings_basis == "course" else "per pack"
    return f"about ₹{alt.approx_savings} saved {scope}"


def _template(name: str, language: Language) -> Any:
    path = Path(TEMPLATE_DIR) / f"{name}.{language.value}.j2"
    return _ENV.from_string(path.read_text(encoding="utf-8"))


def _rows(
    items: list[DetailItem], language: Language
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    found: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for item in items:
        suggestion = item.generic
        if suggestion is not None and suggestion.alternatives:
            found.append(
                {
                    "number": item.number,
                    "name": item.name,
                    "alts": [
                        {
                            "brand": alt.brand_name,
                            "tag": alt.is_janaushadhi
                            and "jan aushadhi" not in alt.brand_name.lower(),
                            "price": _price_text(alt, language),
                            "saving": _saving_text(alt, language),
                        }
                        for alt in suggestion.alternatives
                    ],
                }
            )
        else:
            reason: NoGenericReason = (
                suggestion.reason_if_none if suggestion else None
            ) or "no_match"
            missing.append(
                {"number": item.number, "name": item.name, "reason": _REASONS[language][reason]}
            )
    return found, missing


def allowed_amounts(items: list[DetailItem]) -> set[str]:
    amounts: set[str] = set()
    for item in items:
        for alt in item.generic.alternatives if item.generic else []:
            if alt.pack_price is not None:
                amounts.add(rupees(alt.pack_price))
            amounts.add(rupees(alt.price_per_unit))
            if alt.approx_savings is not None:
                amounts.add(str(alt.approx_savings))
    return amounts


def verify_generic_text(text: str, items: list[DetailItem]) -> list[str]:
    """Reason codes: every ₹ amount and every listed alternative must come from the data."""
    problems: list[str] = []
    allowed = allowed_amounts(items)
    for amount in re.findall(r"₹\s*(\d+(?:\.\d+)?)", text):
        if amount not in allowed:
            problems.append("amount_not_in_data")
            break
    brands = {
        alt.brand_name
        for item in items
        for alt in (item.generic.alternatives if item.generic else [])
    }
    for line in text.splitlines():
        stripped = line.strip()
        if (
            stripped.startswith("•")
            and stripped[1:].strip().split(" — ")[0].replace(" 🏷️ Jan Aushadhi", "").strip()
            not in brands
        ):
            problems.append("brand_not_in_data")
            break
    return problems


def render_generic_reply(items: list[DetailItem], language: Language) -> str:
    """The details message (or the "nothing to suggest" message), with the disclaimer."""
    found, missing = _rows(items, language)
    dates = [
        i.generic.price_source_date for i in items if i.generic and i.generic.price_source_date
    ]
    price_date = _date_text(min(dates)) if dates else None

    def build(use_found: list[dict[str, Any]], use_missing: list[dict[str, Any]]) -> str:
        template = _template("generic_details" if use_found else "generic_none", language)
        body = template.render(found=use_found, missing=use_missing, price_date=price_date)
        return re.sub(r"\n{3,}", "\n\n", body).strip()

    text = build(found, missing)
    problems = verify_generic_text(text, items)
    if problems:
        # A template bug or corrupt data: say nothing about prices rather than something wrong.
        log.warning("generic_grounding_failed", reasons=problems)
        safe = [
            {"number": i.number, "name": i.name, "reason": _REASONS[language]["no_match"]}
            for i in items
        ]
        text = build([], safe)
    return add_disclaimer(text, language)
