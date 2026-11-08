"""The generic finder (M8): the four-key rule, exclusions, savings maths, Jan Aushadhi preference."""

from datetime import date
from decimal import Decimal

import pytest

from app.catalog.repository import DrugRow, InMemoryCatalogRepository
from app.safety.no_substitute import load_policy
from app.schemas.catalog import DrugMatch, MatchMethod
from app.tools.drug_matcher import MatcherConfig
from app.tools.generic_finder import FinderConfig, MedicineFacts, find_generic, units_needed
from tests.catalog_support import match_and_find, repo_of, row, seed_rows

REPO = repo_of(seed_rows())
COURSE = MedicineFacts(dose="1 tablet", frequency_per_day=2, duration_days=5)


def brand(**kw):
    return row(
        brand_name="Brandx", mrp=Decimal(30), pack_qty=Decimal(10), **kw
    )  # Rs 3.00 per tablet


def jan(mrp, **kw):
    return row(brand_name=f"Generic {mrp}", is_janaushadhi=True, mrp=Decimal(mrp), **kw)


def good_match(drug: DrugRow, **kw) -> DrugMatch:
    return DrugMatch(
        drug_id=drug.id,
        brand_name=drug.brand_name,
        salt_key=drug.salt_key,
        strength_key=drug.strength_key,
        form_key=drug.form_key,
        release_type=drug.release_type,
        score=1.0,
        method=MatchMethod.exact,
        strength_basis="brand_name",
        **kw,
    )


async def find(rows, match, facts=None, config=None):
    return await find_generic(
        match,
        facts or MedicineFacts(),
        repo=InMemoryCatalogRepository(rows),
        policy=load_policy(),
        config=config or FinderConfig(),
    )


class TestEndToEndOnTheSeedCatalog:
    async def test_dolo_650_gets_the_jan_aushadhi_alternative_with_course_savings(self):
        match, result = await match_and_find(REPO, "Dolo 650", facts=COURSE)
        assert match.method is MatchMethod.exact
        (alt,) = result.alternatives
        assert alt.is_janaushadhi and alt.brand_name.startswith("Paracetamol Tablets IP 650")
        assert (
            alt.price_per_unit == 1.5 and alt.pack_label == "10 tablet" and alt.pack_price == 15.0
        )
        assert (alt.approx_savings, alt.savings_basis) == (15, "course")  # (3.0 - 1.5) x 10 tablets
        assert result.savings_known and result.price_source_date == date(2026, 1, 1)

    async def test_without_a_duration_the_saving_is_per_pack(self):
        _, result = await match_and_find(REPO, "Dolo 650")
        alt = result.alternatives[0]
        assert (alt.approx_savings, alt.savings_basis) == (15, "pack")

    async def test_a_written_strength_enables_a_brand_without_a_number(self):
        _, result = await match_and_find(REPO, "Cetzine", "10 mg", "tablet", COURSE)
        assert result.alternatives and result.alternatives[0].brand_name.startswith("Cetirizine")

    async def test_without_a_written_strength_a_numberless_brand_gets_nothing(self):
        _, result = await match_and_find(REPO, "Cetzine")
        assert not result.alternatives and result.reason_if_none == "strength_unverified"

    async def test_a_generic_name_prescription_lists_the_alternative_without_a_saving(self):
        match, result = await match_and_find(REPO, "Paracetamol", "500 mg", "tablet")
        assert match.method is MatchMethod.salt_written
        assert result.alternatives and result.alternatives[0].approx_savings is None
        assert not result.savings_known

    async def test_plain_metformin_gets_only_the_plain_generic_never_the_sr(self):
        _, result = await match_and_find(REPO, "Glycomet 500")
        assert [a.brand_name for a in result.alternatives] == [
            "Metformin Hydrochloride Tablets IP 500 mg (Jan Aushadhi)"
        ]

    @pytest.mark.parametrize(
        ("name", "strength", "reason"),
        [
            ("Glycomet SR 500", None, "not_substitutable"),  # modified release
            ("Metolar XR 50", None, "not_substitutable"),
            ("Thyronorm 50", "50 mcg", "not_substitutable"),  # narrow therapeutic index
            ("Eltroxin 50", "50 mcg", "not_substitutable"),
            ("Uniwarfin 5", None, "not_substitutable"),
            ("Lanoxin", "0.25 mg", "not_substitutable"),
            ("Eptoin 100", None, "not_substitutable"),
            ("Tegretol 200", None, "not_substitutable"),
            ("Lantus", "100 IU/ml", "not_substitutable"),  # insulin
            ("Asthalin", "100 mcg", "not_substitutable"),  # inhaler
            ("Pantop 40", None, "not_substitutable"),  # delayed release: excluded until reviewed
            ("Zzzz 10", None, "no_match"),
        ],
    )
    async def test_excluded_or_unmatched_medicines_never_get_a_suggestion(
        self, name, strength, reason
    ):
        _, result = await match_and_find(REPO, name, strength)
        assert result.alternatives == [] and result.reason_if_none == reason

    async def test_a_conflicting_written_strength_blocks_the_suggestion(self):
        _, result = await match_and_find(REPO, "Dolo 650", "500 mg")
        assert result.alternatives == [] and result.reason_if_none == "strength_mismatch"

    async def test_a_form_conflict_blocks_the_suggestion(self):
        _, result = await match_and_find(REPO, "Dolo 650", None, "syrup")
        assert result.reason_if_none == "form_mismatch"

    async def test_an_ambiguous_match_blocks_the_suggestion(self):
        # A short, strength-less name scores low (weak_match); lower the bar to reach the ambiguity check.
        _, weak = await match_and_find(REPO, "Atorva")
        assert weak.alternatives == [] and weak.reason_if_none == "weak_match"
        _, result = await match_and_find(REPO, "Atorva", finder_config=FinderConfig(match_min=0.5))
        assert result.alternatives == [] and result.reason_if_none == "ambiguous"

    async def test_a_low_confidence_line_never_gets_a_suggestion(self):
        _, result = await match_and_find(REPO, "Dolo 650", facts=MedicineFacts(low_confidence=True))
        assert result.reason_if_none == "low_confidence"

    async def test_a_weak_match_is_not_enough(self):
        _, result = await match_and_find(
            REPO,
            "Pentop 40",
            match_config=MatcherConfig(),
            finder_config=FinderConfig(match_min=0.99),
        )
        assert result.reason_if_none == "weak_match"


class TestTheFourKeyRule:
    """Whatever else is in the catalog, only an exact match on all four keys is offered."""

    async def test_near_misses_in_every_key_are_never_suggested(self):
        original = brand()
        near = [
            jan(1, strength_key="500mg"),  # other strength
            jan(1, strength_key="1000mg"),
            jan(1, salt_key="paracetamol+caffeine"),  # other salt
            jan(1, salt_key="ibuprofen"),
            jan(1, form_key="capsule"),  # other form
            jan(1, form_key="syrup"),
            jan(1, release_type="sr"),  # other release type
            jan(1, release_type="dr"),
        ]
        result = await find([original, *near], good_match(original))
        assert result.alternatives == [] and result.reason_if_none == "no_exact_alternative"

    async def test_the_exact_row_is_found_among_the_near_misses(self):
        original = brand()
        exact = jan(12)
        result = await find([original, jan(1, strength_key="500mg"), exact], good_match(original))
        assert [a.drug_id for a in result.alternatives] == [exact.id]

    async def test_a_misbehaving_repository_cannot_smuggle_a_wrong_row_through(self):
        original = brand()

        class Bad(InMemoryCatalogRepository):
            async def alternatives(self, *args):  # ignores the keys on purpose
                return [
                    jan(1, strength_key="500mg"),
                    jan(1, release_type="sr"),
                    jan(1, form_key="syrup"),
                ]

        result = await find_generic(
            good_match(original),
            MedicineFacts(),
            repo=Bad([original]),
            policy=load_policy(),
            config=FinderConfig(),
        )
        assert result.alternatives == []

    async def test_the_prescribed_product_itself_is_never_its_own_alternative(self):
        original = brand()
        result = await find([original], good_match(original))
        assert result.alternatives == [] and result.reason_if_none == "no_exact_alternative"


class TestSavings:
    async def test_the_minimum_saving_filter(self):
        original = brand()  # Rs 3.00 per tablet
        cheap_enough = jan(25)  # Rs 2.50: 16.7% cheaper
        too_close = jan(26)  # Rs 2.60: 13.3% cheaper
        result = await find([original, cheap_enough, too_close], good_match(original))
        assert [a.drug_id for a in result.alternatives] == [cheap_enough.id]

    async def test_nothing_cheaper_enough_says_so(self):
        original = brand()
        result = await find([original, jan(29), jan(35)], good_match(original))
        assert result.alternatives == [] and result.reason_if_none == "no_cheaper_option"

    async def test_the_threshold_is_configurable(self):
        original = brand()
        result = await find(
            [original, jan(26)], good_match(original), config=FinderConfig(min_savings_pct=10)
        )
        assert len(result.alternatives) == 1

    async def test_course_saving_uses_dose_frequency_and_duration(self):
        original = brand()
        result = await find([original, jan(10)], good_match(original), COURSE)  # Rs 1.00 vs 3.00
        alt = result.alternatives[0]
        assert (alt.approx_savings, alt.savings_basis) == (20, "course")

    async def test_half_a_tablet_counts_half(self):
        original = brand()
        facts = MedicineFacts(dose="1/2 tablet", frequency_per_day=2, duration_days=10)
        result = await find([original, jan(10)], good_match(original), facts)
        assert result.alternatives[0].approx_savings == 20  # 10 tablets x Rs 2.00

    async def test_as_needed_falls_back_to_the_pack_saving(self):
        original = brand()
        facts = MedicineFacts(dose="1 tablet", as_needed=True)
        result = await find([original, jan(10)], good_match(original), facts)
        alt = result.alternatives[0]
        assert alt.savings_basis == "pack" and alt.approx_savings == 20

    async def test_syrups_are_priced_per_ml(self):
        kw = {
            "form_key": "syrup",
            "strength_key": "250mg/5ml",
            "pack_unit": "ml",
            "pack_qty": Decimal(60),
        }
        original = row(brand_name="Brandx", mrp=Decimal(60), **kw)
        alt = jan(25, **kw)
        facts = MedicineFacts(dose="5 ml", frequency_per_day=3, duration_days=4)
        result = await find([original, alt], good_match(original), facts)
        assert result.alternatives[0].approx_savings == 35  # 60 ml x (Rs 1.00 - Rs 0.4167)

    async def test_an_unknown_brand_price_never_becomes_a_savings_claim(self):
        original = row(brand_name="Brandx")  # no price
        alt = jan(10)
        result = await find([original, alt], good_match(original), COURSE)
        assert [a.drug_id for a in result.alternatives] == [alt.id]
        assert result.alternatives[0].approx_savings is None and not result.savings_known

    async def test_prices_in_different_units_are_not_compared(self):
        original = brand(pack_unit="unit")
        result = await find([original, jan(10)], good_match(original), COURSE)
        assert result.alternatives[0].approx_savings is None

    async def test_units_needed(self):
        assert units_needed(COURSE, "tablet") == Decimal(10)
        two = MedicineFacts(dose="2 tablets", frequency_per_day=3, duration_days=3)
        assert units_needed(two, "tablet") == 18
        ml = MedicineFacts(dose="5 ml", frequency_per_day=2, duration_days=5)
        assert units_needed(ml, "syrup") == 50
        assert units_needed(ml, "tablet") is None
        assert units_needed(MedicineFacts(dose="1 tablet", frequency_per_day=2), "tablet") is None
        vague = MedicineFacts(dose="as directed", frequency_per_day=2, duration_days=2)
        assert units_needed(vague, "tablet") is None


class TestOrderingAndLimits:
    async def test_cheapest_first_and_at_most_two(self):
        original = brand()
        a, b, c = (row(brand_name=f"Alt{n}", mrp=Decimal(n)) for n in (20, 10, 15))
        result = await find([original, a, b, c], good_match(original))
        assert [x.drug_id for x in result.alternatives] == [b.id, c.id]

    async def test_jan_aushadhi_goes_first_when_within_ten_percent_of_the_cheapest(self):
        original = brand()
        cheapest = row(brand_name="Cheapest", mrp=Decimal(10))
        ja = jan(11)  # 10% above the cheapest
        result = await find([original, cheapest, ja], good_match(original))
        assert [x.drug_id for x in result.alternatives] == [ja.id, cheapest.id]

    async def test_jan_aushadhi_does_not_jump_the_queue_when_clearly_dearer(self):
        original = brand()
        cheapest = row(brand_name="Cheapest", mrp=Decimal(10))
        ja = jan(12)  # 20% above
        result = await find([original, cheapest, ja], good_match(original))
        assert [x.drug_id for x in result.alternatives] == [cheapest.id, ja.id]

    async def test_the_oldest_price_date_is_reported(self):
        original = brand(price_source_date=date(2026, 3, 1))
        alt = jan(10, price_source_date=date(2025, 12, 1))
        result = await find([original, alt], good_match(original))
        assert result.price_source_date == date(2025, 12, 1)


class TestPolicyFile:
    def test_levothyroxine_and_friends_are_blocked(self):
        policy = load_policy()
        for salt in (
            "levothyroxine sodium",
            "warfarin sodium",
            "carbamazepine",
            "phenytoin sodium",
            "lithium carbonate",
            "digoxin",
            "tacrolimus",
            "cyclosporine",
        ):
            assert policy.reason(salt_key=salt, form_key="tablet", release_type="ir"), salt

    def test_valproate_is_caught_by_its_prefix(self):
        assert load_policy().reason(salt_key="valproic acid", form_key="tablet", release_type="ir")

    def test_biologics_and_insulin(self):
        policy = load_policy()
        for salt in ("insulin glargine", "adalimumab", "trastuzumab", "insulin aspart"):
            assert policy.reason(salt_key=salt, form_key="injection", release_type="na"), salt

    def test_every_modified_release_type_and_unclassified_form_is_blocked(self):
        policy = load_policy()
        for release in ("sr", "er", "xr", "cr", "mr", "dr"):
            assert policy.reason(salt_key="metformin", form_key="tablet", release_type=release)
        for form in ("inhaler", "other"):
            assert policy.reason(salt_key="salbutamol", form_key=form, release_type="na")

    def test_plain_products_pass(self):
        ok = load_policy()
        assert ok.reason(salt_key="paracetamol", form_key="tablet", release_type="ir") is None
        assert ok.reason(salt_key="amoxicillin", form_key="suspension", release_type="na") is None
