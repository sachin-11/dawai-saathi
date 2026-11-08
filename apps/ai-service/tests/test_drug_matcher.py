"""The drug matcher (M8): every stage, the ordering, the thresholds and the strength rules."""

import pytest

from app.catalog.repository import similarity, trigrams
from app.schemas.catalog import MatchMethod
from app.tools.drug_matcher import MatcherConfig, match_drug
from tests.catalog_support import repo_of, row, seed_rows, vector_of

REPO = repo_of(seed_rows())
CONFIG = MatcherConfig()


async def match(name, strength=None, form=None, repo=REPO, vector=None, config=CONFIG):
    return await match_drug(name, strength, form, repo=repo, vector=vector, config=config)


class TestTrigrams:
    def test_follows_pg_trgm(self):
        assert trigrams("cat") == {"  c", " ca", "cat", "at "}
        assert similarity("dolo650", "dolo650") == 1.0
        assert similarity("abc", "xyz") == 0.0
        assert similarity("pantop", "pantop40") == pytest.approx(0.6)


class TestExact:
    @pytest.mark.parametrize(
        "name",
        [
            "Dolo 650",
            "dolo650",
            "Dolo-650",
            "DOLO 650 TAB",
            "Tab. Dolo 650",
            "Tab Dolo-650",
            "डोलो 650",
        ],
    )
    async def test_spellings_of_one_brand(self, name):
        result = await match(name)
        assert result.method is MatchMethod.exact and result.score == 1.0
        assert (result.salt_key, result.strength_key, result.form_key) == (
            "paracetamol",
            "650mg",
            "tablet",
        )
        assert result.release_type == "ir"

    async def test_the_number_in_the_brand_name_confirms_the_strength(self):
        assert (await match("Dolo 650")).strength_basis == "brand_name"

    async def test_name_plus_written_strength_finds_the_numbered_brand(self):
        result = await match("Dolo", "650 mg")
        assert result.method is MatchMethod.exact and result.brand_name == "Dolo 650"
        assert result.strength_basis == "prescription"

    async def test_a_combination_matches_with_its_composition(self):
        result = await match("Augmentin 625 Duo")
        assert (
            result.salt_key == "amoxicillin+clavulanic acid"
            and result.strength_key == "500mg+125mg"
        )
        assert result.strength_basis == "brand_name"  # 625 = 500 + 125

    async def test_telma_am_has_no_number_so_the_strength_is_unverified(self):
        result = await match("Telma-AM")
        assert result.salt_key == "amlodipine+telmisartan" and result.strength_basis == "none"

    async def test_priced_rows_are_preferred_among_equal_brands(self):
        result = await match("Dolo 500")
        assert (
            result.drug_id is not None and "fixture" in result.drug_id
        ) or "test-fix" in result.drug_id


class TestStrengthRules:
    async def test_a_different_written_strength_is_a_conflict_and_the_prescription_wins(self):
        result = await match("Dolo 650", "500 mg")
        assert result.strength_conflict and result.note == "strength_conflict"
        assert result.strength_basis == "none"

    async def test_a_combination_total_is_accepted(self):
        result = await match("Augmentin", "625 mg")
        assert result.method in {MatchMethod.trgm, MatchMethod.exact}
        assert result.strength_basis == "prescription" and not result.strength_conflict

    async def test_several_written_strengths_stay_unverified_not_guessed(self):
        result = await match("Telma-AM", "40 mg + 5 mg")
        assert result.strength_basis == "none" and not result.strength_conflict

    async def test_a_clearly_different_form_is_a_conflict(self):
        result = await match("Dolo 650", None, "syrup")
        assert result.form_conflict and result.note == "form_conflict"

    async def test_syrup_and_suspension_are_compatible(self):
        syrup = row(brand_name="Kidsyrup", form_key="suspension", strength_key="250mg/5ml")
        result = await match("Kidsyrup", "250 mg/5 ml", "syrup", repo=repo_of([syrup]))
        assert not result.form_conflict and result.strength_basis == "prescription"


class TestSaltWritten:
    async def test_a_generic_name_with_strength_matches_the_salt(self):
        result = await match("Metformin", "500 mg", "tablet")
        assert result.method is MatchMethod.salt_written and result.score == 0.9
        assert (result.salt_key, result.strength_key, result.release_type) == (
            "metformin",
            "500mg",
            "ir",
        )
        assert result.drug_id is None and result.strength_basis == "prescription"

    async def test_no_release_word_means_the_plain_product_never_the_sr(self):
        assert (await match("Metformin", "500 mg", "tablet")).release_type == "ir"
        assert (await match("Metformin SR", "500 mg", "tablet")).release_type == "sr"

    async def test_no_form_and_no_release_word_still_picks_the_plain_product(self):
        result = await match("Paracetamol", "500 mg")
        assert result.method is MatchMethod.salt_written and result.release_type == "ir"

    async def test_a_plain_prescription_is_never_tied_to_a_modified_release_product(self):
        sr_only = [
            row(
                brand_name="Metformin SR",
                salt_key="metformin",
                strength_key="500mg",
                release_type="sr",
            )
        ]
        result = await match("Metformin", "500 mg", "tablet", repo=repo_of(sr_only))
        # The salt stage refuses; the fuzzy brand stage may find the name but flags the release mismatch,
        # which blocks any generic (the finder refuses on a form/release conflict).
        assert result.method is not MatchMethod.salt_written
        assert result.method is MatchMethod.none or (
            result.form_conflict and result.note == "release_conflict"
        )

    async def test_hindi_salt_name(self):
        result = await match("पैरासिटामोल", "500 mg", "tablet")
        assert result.method is MatchMethod.salt_written and result.salt_key == "paracetamol"

    async def test_a_salt_without_a_strength_is_not_matched_by_salt(self):
        result = await match("Metformin", None, "tablet")
        assert result.method is not MatchMethod.salt_written

    async def test_runs_before_trigram_so_a_generic_name_is_not_fuzzy_matched_to_a_brand(self):
        rows = [
            row(brand_name="Paracetamolx", salt_key="other", strength_key="500mg"),
            row(
                brand_name="Paracetamol IP",
                salt_key="paracetamol",
                strength_key="500mg",
                is_janaushadhi=True,
            ),
        ]
        result = await match("Paracetamol", "500 mg", "tablet", repo=repo_of(rows))
        assert result.method is MatchMethod.salt_written and result.salt_key == "paracetamol"


class TestTrigram:
    async def test_a_typo(self):
        result = await match("Pentop 40")
        assert result.method is MatchMethod.trgm and result.brand_name == "Pantop 40"
        assert 0.45 <= result.score < 1.0

    async def test_trailing_noise(self):
        assert (await match("Dolo650mg")).brand_name == "Dolo 650"

    async def test_below_the_threshold_nothing_matches(self):
        strict = MatcherConfig(trgm_min=0.95)
        assert (await match("Pentop 40", config=strict)).method is MatchMethod.none

    async def test_a_written_strength_boosts_the_score(self):
        with_strength = await match("Augmentin", "625 mg")
        without = await match("Augmentin")
        assert with_strength.score > without.score

    async def test_two_strengths_of_one_brand_are_ambiguous_without_a_written_strength(self):
        result = await match("Atorva")
        assert result.ambiguous and result.note == "ambiguous"
        assert {c.brand_name for c in result.candidates} >= {"Atorva 10", "Atorva 20"}

    async def test_an_ambiguous_match_states_only_what_every_candidate_agrees_on(self):
        result = await match("Atorva")
        assert result.salt_key == "atorvastatin" and result.form_key == "tablet"
        assert result.strength_key is None and result.drug_id is None and result.brand_name is None

    async def test_ambiguity_between_different_salts_states_no_salt(self):
        rows = [
            row(brand_name="Zolpa 10", salt_key="alpha", strength_key="10mg"),
            row(brand_name="Zolpa 20", salt_key="beta", strength_key="20mg"),
        ]
        result = await match("Zolpa", repo=repo_of(rows))
        assert result.ambiguous and result.salt_key is None

    async def test_a_brand_prefix_matches_the_family_but_never_confirms_a_product(self):
        for name in ("Dolo", "डोलो"):
            result = await match(name)
            assert result.method is MatchMethod.trgm and result.ambiguous
            assert result.salt_key == "paracetamol" and result.score < 0.8

    async def test_a_written_strength_resolves_the_ambiguity(self):
        result = await match("Atorva", "20 mg")
        assert not result.ambiguous and result.strength_key == "20mg"

    async def test_top_three_candidates_are_reported(self):
        result = await match("Pentop 40")
        assert 1 <= len(result.candidates) <= 3


class TestVectorFallback:
    async def test_only_used_when_the_other_stages_find_nothing(self):
        rows = [row(brand_name="Pantop 40", salt_key="pantoprazole", strength_key="40mg")]
        vector = await vector_of(rows)
        weak_trgm = MatcherConfig(trgm_min=0.99, vector_min=0.3)
        result = await match("Pentop 40", repo=repo_of(rows), vector=vector, config=weak_trgm)
        assert result.method is MatchMethod.vector and result.score <= 0.95
        assert result.strength_basis == "none"  # a vector hit never confirms a strength by itself

    async def test_a_vector_hit_below_the_threshold_is_ignored(self):
        rows = [row(brand_name="Pantop 40", salt_key="pantoprazole", strength_key="40mg")]
        vector = await vector_of(rows)
        strict = MatcherConfig(trgm_min=0.99, vector_min=0.99)
        assert (
            await match("Zzzz", repo=repo_of(rows), vector=vector, config=strict)
        ).method is MatchMethod.none

    async def test_stage_one_wins_even_when_a_vector_store_exists(self):
        vector = await vector_of(seed_rows())
        assert (await match("Dolo 650", vector=vector)).method is MatchMethod.exact


class TestNoMatch:
    @pytest.mark.parametrize("name", ["Zzxq 10", "Unknownbrand", "", "   ", "!!!"])
    async def test_unknown_names(self, name):
        result = await match(name)
        assert result.method is MatchMethod.none and result.drug_id is None
        assert result.salt_key is None and result.score == 0.0
