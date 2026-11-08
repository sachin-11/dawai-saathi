"""Generic finder (M8): cheaper alternatives with the EXACT same salt + strength + form + release type.

Hard rules (CLAUDE.md §2.4; the eval gates these at zero violations):
  * all four keys must be equal: no "close enough"
  * only for a confident match whose strength was confirmed, with a readable (not low-confidence) line
  * never for narrow-therapeutic-index drugs, insulins/biologics, modified-release products, inhalers
    or forms we could not classify (`app/safety/no_substitute.yaml`)
  * a saving is only stated when BOTH the brand price and the alternative price are known; an
    unknown brand price never becomes a claim that the alternative is cheaper
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from app.catalog.repository import CatalogRepository, DrugRow
from app.safety.no_substitute import NoSubstitutePolicy
from app.schemas.catalog import (
    DrugMatch,
    GenericAlternative,
    GenericSuggestion,
    MatchMethod,
    NoGenericReason,
)
from app.tools.rx_validate import dose_amount

MAX_ALTERNATIVES = 2
JAN_AUSHADHI_WINDOW = Decimal("1.10")
_COUNT_UNITS = {
    "tab",
    "tabs",
    "tablet",
    "tablets",
    "cap",
    "caps",
    "capsule",
    "capsules",
    "goli",
    "",
}
_COUNT_FORMS = {"tablet", "capsule"}
_VOLUME_FORMS = {"syrup", "suspension", "drops"}


@dataclass(frozen=True, slots=True)
class FinderConfig:
    match_min: float = 0.8
    min_savings_pct: float = 15.0


@dataclass(frozen=True, slots=True)
class MedicineFacts:
    """What the prescription says about HOW MUCH is needed (all optional)."""

    low_confidence: bool = False
    dose: str | None = None
    frequency_per_day: int | None = None
    duration_days: int | None = None
    as_needed: bool = False


def _none(reason: NoGenericReason) -> GenericSuggestion:
    return GenericSuggestion(reason_if_none=reason)


def units_needed(facts: MedicineFacts, form_key: str) -> Decimal | None:
    """dose x per day x days, in the unit prices are quoted in (tablets, capsules or ml)."""
    if facts.as_needed or not facts.frequency_per_day or not facts.duration_days or not facts.dose:
        return None
    parsed = dose_amount(facts.dose)
    if parsed is None:
        return None
    amount, unit = parsed
    if (form_key in _COUNT_FORMS and unit in _COUNT_UNITS) or (
        form_key in _VOLUME_FORMS and unit == "ml"
    ):
        per_dose = Decimal(str(amount))
    else:
        return None
    return per_dose * facts.frequency_per_day * facts.duration_days


def _units_comparable(brand: DrugRow, alt: DrugRow) -> bool:
    return bool(brand.pack_unit) and brand.pack_unit == alt.pack_unit


def _order(candidates: list[DrugRow]) -> list[DrugRow]:
    """Cheapest first; the cheapest Jan Aushadhi product goes first if it is within 10% of the cheapest."""
    by_price = sorted(candidates, key=lambda r: (r.price_per_unit or Decimal(0), r.brand_name))
    cheapest = by_price[0].price_per_unit or Decimal(0)
    jan = next(
        (
            r
            for r in by_price
            if r.is_janaushadhi and (r.price_per_unit or 0) <= cheapest * JAN_AUSHADHI_WINDOW
        ),
        None,
    )
    return [jan, *[r for r in by_price if r is not jan]] if jan else by_price


def _pack_label(row: DrugRow) -> str | None:
    if row.pack_qty is None or not row.pack_unit:
        return None
    return f"{format(row.pack_qty.normalize(), 'f')} {row.pack_unit}"


def _alternative(
    alt: DrugRow, brand: DrugRow | None, facts: MedicineFacts, form_key: str, min_pct: float
) -> GenericAlternative | None:
    assert alt.price_per_unit is not None  # noqa: S101 - the repository only returns priced rows
    saving: int | None = None
    basis: str | None = None
    if brand is not None and brand.price_per_unit is not None and _units_comparable(brand, alt):
        difference = brand.price_per_unit - alt.price_per_unit
        if difference <= 0 or difference / brand.price_per_unit * 100 < Decimal(str(min_pct)):
            return None  # not cheaper by enough: not worth suggesting
        units = units_needed(facts, form_key)
        if units is not None:
            saving, basis = round(difference * units), "course"
        elif alt.pack_qty is not None:
            saving, basis = round(difference * alt.pack_qty), "pack"
        if saving is not None and saving <= 0:
            return None
    return GenericAlternative(
        drug_id=alt.id,
        brand_name=alt.brand_name[:200],
        is_janaushadhi=alt.is_janaushadhi,
        price_per_unit=float(alt.price_per_unit),
        pack_label=_pack_label(alt),
        pack_price=float(alt.mrp) if alt.mrp is not None else None,
        approx_savings=saving,
        savings_basis=basis,  # type: ignore[arg-type]
    )


async def find_generic(
    match: DrugMatch,
    facts: MedicineFacts,
    *,
    repo: CatalogRepository,
    policy: NoSubstitutePolicy,
    config: FinderConfig,
) -> GenericSuggestion:
    """The suggestion for ONE medicine; `reason_if_none` says why there is none."""
    if facts.low_confidence:
        return _none("low_confidence")
    if match.method is MatchMethod.none:
        return _none("no_match")
    if match.score < config.match_min:
        return _none("weak_match")
    if match.strength_conflict:
        return _none("strength_mismatch")
    if match.form_conflict:
        return _none("form_mismatch")
    if match.ambiguous:
        return _none("ambiguous")
    if match.strength_basis == "none":
        return _none("strength_unverified")
    if not (match.salt_key and match.strength_key and match.form_key and match.release_type):
        return _none("no_match")
    if policy.reason(
        salt_key=match.salt_key, form_key=match.form_key, release_type=match.release_type
    ):
        return _none("not_substitutable")

    rows = await repo.alternatives(
        match.salt_key, match.strength_key, match.form_key, match.release_type
    )
    # Defence in depth: whatever the repository returned, only exact four-key equality passes.
    exact = [
        r
        for r in rows
        if r.key == (match.salt_key, match.strength_key, match.form_key, match.release_type)
        and r.id != match.drug_id
        and r.price_per_unit is not None
        and r.price_per_unit > 0
    ]
    if not exact:
        return _none("no_exact_alternative")

    brand: DrugRow | None = None
    if match.drug_id:
        (brand,) = (await repo.by_ids([match.drug_id]))[:1] or (None,)

    alternatives: list[GenericAlternative] = []
    for row in _order(exact):
        built = _alternative(row, brand, facts, match.form_key, config.min_savings_pct)
        if built is not None:
            alternatives.append(built)
        if len(alternatives) == MAX_ALTERNATIVES:
            break
    if not alternatives:
        return _none("no_cheaper_option")

    dates: list[date] = [
        d
        for d in [
            *[r.price_source_date for r in exact if r.id in {a.drug_id for a in alternatives}],
            brand.price_source_date
            if brand is not None and brand.price_per_unit is not None
            else None,
        ]
        if d is not None
    ]
    return GenericSuggestion(
        alternatives=alternatives,
        price_source_date=min(dates) if dates else None,
        savings_known=any(a.approx_savings is not None for a in alternatives),
    )
