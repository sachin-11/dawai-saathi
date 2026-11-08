"""The interaction checker (M11): duplicates, pairs, combinations, ordering, honesty about gaps."""

import pytest

from app.interactions.repository import FailingInteractionRepository, InMemoryInteractionRepository
from app.interactions.service import (
    InteractionService,
    salt_from_name,
    stored_medications,
    typed_medications,
)
from app.schemas.catalog import DrugMatch, MatchMethod
from app.schemas.process import ActiveMedication
from app.tools.interaction_check import (
    check_interactions,
    components,
    salt_is_certain,
    sort_findings,
)
from tests.interaction_support import core_repo, med, pair


def repo(*rows):
    return InMemoryInteractionRepository(rows)


class TestComponents:
    def test_a_combination_is_split_into_its_salts(self):
        assert components("amlodipine+telmisartan") == ["amlodipine", "telmisartan"]

    def test_salt_forms_map_to_the_active_moiety(self):
        assert components("warfarin sodium") == ["warfarin"]
        assert components("diclofenac sodium+paracetamol") == ["diclofenac", "paracetamol"]

    def test_duplicates_inside_a_key_collapse(self):
        assert components("paracetamol+paracetamol") == ["paracetamol"]


class TestDuplicateIngredient:
    async def test_the_same_salt_in_two_products_is_a_duplicate(self):
        report = await check_interactions(
            [med("rx:0", "paracetamol", "Dolo 650"), med("rx:1", "paracetamol", "Crocin 500")],
            repo(),
        )
        (finding,) = report.findings
        assert finding.type == "duplicate_ingredient"
        assert finding.salt_a == finding.salt_b == "paracetamol"
        assert finding.medication_refs == ["rx:0", "rx:1"]
        assert finding.management_key == "duplicate_overdose"

    async def test_paracetamol_inside_a_combination_counts(self):
        report = await check_interactions(
            [med("a", "paracetamol", "Dolo"), med("b", "ibuprofen+paracetamol", "Combiflam")],
            repo(),
        )
        assert [(f.type, f.salt_a) for f in report.findings] == [
            ("duplicate_ingredient", "paracetamol")
        ]

    async def test_a_non_overdose_salt_uses_the_plain_duplicate_wording(self):
        report = await check_interactions(
            [med("a", "amlodipine", "Amlong"), med("b", "amlodipine+telmisartan", "Telma-AM")],
            repo(),
        )
        assert report.findings[0].management_key == "duplicate"

    async def test_one_medicine_alone_is_never_a_duplicate_of_itself(self):
        report = await check_interactions([med("a", "ibuprofen+paracetamol", "Combiflam")], repo())
        assert report.findings == []

    async def test_the_same_medicine_listed_twice_with_one_id_is_one_medicine(self):
        report = await check_interactions(
            [med("a", "paracetamol", "Dolo"), med("a", "paracetamol", "Dolo")], repo()
        )
        assert report.findings == []

    async def test_two_stored_medicines_alone_are_not_announced_again(self):
        stored = [med("s1", "paracetamol", new=False), med("s2", "paracetamol", new=False)]
        assert (await check_interactions(stored, repo(), only_new=True)).findings == []
        assert len((await check_interactions(stored, repo(), only_new=False)).findings) == 1

    async def test_a_new_medicine_duplicating_a_stored_one_is_found(self):
        report = await check_interactions(
            [med("rx:0", "paracetamol", "Dolo 650"), med("s1", "paracetamol", "Crocin", new=False)],
            repo(),
        )
        assert report.findings[0].involves_new


class TestPairs:
    async def test_a_known_pair_is_found_in_either_order(self):
        rows = [pair("ibuprofen", "warfarin", "major", "bleeding")]
        for first, second in (("warfarin", "ibuprofen"), ("ibuprofen", "warfarin")):
            report = await check_interactions(
                [med("a", first, "A"), med("b", second, "B")], repo(*rows)
            )
            (finding,) = report.findings
            assert (finding.salt_a, finding.salt_b) == ("ibuprofen", "warfarin")
            assert finding.severity == "major"
            assert finding.effect_code == "bleeding"

    async def test_a_pair_inside_one_combination_product_is_not_compared(self):
        rows = [pair("amlodipine", "telmisartan", "major")]
        report = await check_interactions([med("a", "amlodipine+telmisartan")], repo(*rows))
        assert report.findings == []

    async def test_a_combination_hides_a_pair_with_another_medicine(self):
        rows = [pair("ibuprofen", "warfarin", "major")]
        report = await check_interactions(
            [med("a", "ibuprofen+paracetamol", "Combiflam"), med("b", "warfarin", "Warf")],
            repo(*rows),
        )
        (finding,) = report.findings
        assert finding.medication_refs == ["a", "b"]
        assert finding.labels == ["Combiflam", "Warf"]

    async def test_no_row_means_no_finding_and_not_a_safety_claim(self):
        report = await check_interactions(
            [med("a", "paracetamol"), med("b", "metformin")], repo(pair("a1", "b1"))
        )
        assert report.findings == []
        assert report.checked_count == 2 and report.database_ok

    async def test_an_old_pair_between_stored_medicines_is_not_announced_again(self):
        rows = [pair("ibuprofen", "warfarin", "major")]
        stored = [med("s1", "warfarin", new=False), med("s2", "ibuprofen", new=False)]
        assert (await check_interactions(stored, repo(*rows))).findings == []
        assert len((await check_interactions(stored, repo(*rows), only_new=False)).findings) == 1

    async def test_a_new_medicine_against_a_stored_one_is_found(self):
        rows = [pair("ibuprofen", "warfarin", "major")]
        report = await check_interactions(
            [med("rx:0", "ibuprofen", "Brufen"), med("s1", "warfarin", "Warf", new=False)],
            repo(*rows),
        )
        assert report.findings[0].involves_new

    async def test_the_same_pair_from_three_medicines_is_one_finding(self):
        rows = [pair("diclofenac", "warfarin", "major")]
        report = await check_interactions(
            [
                med("a", "diclofenac", "Voveran"),
                med("b", "diclofenac", "Dynapar"),
                med("c", "warfarin", "Warf"),
            ],
            repo(*rows),
        )
        kinds = sorted((f.type, f.salt_a) for f in report.findings)
        assert kinds == [("duplicate_ingredient", "diclofenac"), ("interaction", "diclofenac")]
        pair_finding = next(f for f in report.findings if f.type == "interaction")
        assert sorted(pair_finding.medication_refs) == ["a", "b", "c"]


class TestOrdering:
    async def test_major_then_duplicate_then_moderate_then_minor(self):
        rows = [
            pair("a1", "b1", "minor"),
            pair("a2", "b2", "moderate"),
            pair("a3", "b3", "major"),
        ]
        meds = [
            med("1", "a1+a2+a3+paracetamol"),
            med("2", "b1+b2+b3+paracetamol"),
        ]
        report = await check_interactions(meds, repo(*rows))
        order = [(f.type, f.severity) for f in report.findings]
        assert order == [
            ("interaction", "major"),
            ("duplicate_ingredient", None),
            ("interaction", "moderate"),
            ("interaction", "minor"),
        ]

    def test_ties_are_broken_by_salt_name(self):
        from app.schemas.interactions import InteractionFinding

        def finding(a, b):
            return InteractionFinding(
                type="interaction", severity="major", salt_a=a, salt_b=b, management_key="major"
            )

        ordered = sort_findings([finding("m", "z"), finding("a", "z")])
        assert [f.salt_a for f in ordered] == ["a", "m"]


class TestHonesty:
    async def test_a_medicine_without_a_certain_salt_is_reported_as_unchecked(self):
        report = await check_interactions(
            [med("a", "paracetamol", "Dolo"), med("b", None, "Mystery")], repo()
        )
        assert [(u.ref, u.label) for u in report.unchecked] == [("b", "Mystery")]
        assert report.checked_count == 1

    async def test_a_database_failure_is_not_turned_into_no_interaction(self):
        report = await check_interactions(
            [med("a", "ibuprofen"), med("b", "warfarin")], FailingInteractionRepository()
        )
        assert report.database_ok is False
        assert report.findings == []  # but the caller says "could not check", never "none found"

    async def test_the_service_resolves_the_used_salt_for_new_medicines(self):
        service = InteractionService(repo())
        report = await service.check([med("rx:0", "paracetamol"), med("s", "x", new=False)])
        assert [(r.ref, r.salt_key) for r in report.resolved] == [("rx:0", "paracetamol")]


class TestSaltCertainty:
    def match(self, **kw):
        values = {
            "salt_key": "paracetamol",
            "method": MatchMethod.trgm,
            "score": 0.9,
            "brand_name": "Dolo 650",
        }
        values.update(kw)
        return DrugMatch(**values)

    def test_a_confident_match_is_certain(self):
        assert salt_is_certain(self.match(), 0.8)

    def test_no_match_or_no_salt_is_not(self):
        assert not salt_is_certain(None, 0.8)
        assert not salt_is_certain(self.match(salt_key=None), 0.8)
        assert not salt_is_certain(self.match(method=MatchMethod.none), 0.8)

    def test_a_written_salt_is_certain_at_any_score(self):
        assert salt_is_certain(self.match(method=MatchMethod.salt_written, score=0.1), 0.8)

    def test_a_brand_family_prefix_is_certain_even_below_the_threshold(self):
        assert salt_is_certain(self.match(score=0.67), 0.8, "Dolo")

    def test_a_weak_fuzzy_match_that_is_not_a_prefix_is_not(self):
        assert not salt_is_certain(self.match(score=0.6, brand_name="Dolo 650"), 0.8, "Dollo")
        assert not salt_is_certain(self.match(score=0.6), 0.8, None)
        assert not salt_is_certain(self.match(score=0.4), 0.8, "Dolo")

    def test_a_vector_match_below_the_threshold_is_not(self):
        assert not salt_is_certain(self.match(method=MatchMethod.vector, score=0.7), 0.8, "Dolo")


class TestNameFallback:
    KNOWN = frozenset({"warfarin", "ibuprofen", "paracetamol", "aspirin"})

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("Warfarin", "warfarin"),
            ("Tab. Warfarin 5 mg", "warfarin"),
            ("Ibuprofen + Paracetamol", "ibuprofen+paracetamol"),
            ("warfarin sodium", None),  # not known by that exact name -> not guessed
            ("Brufen", None),  # a brand is never resolved by name
            ("Dolo 650", None),
            ("", None),
            (None, None),
        ],
    )
    def test_only_exact_known_salts_resolve(self, name, expected):
        assert salt_from_name(name, self.KNOWN) == expected

    def test_nothing_resolves_when_no_salt_is_known(self):
        assert salt_from_name("Warfarin", frozenset()) is None


class TestInputs:
    def test_stored_medicines_without_a_salt_key_are_unchecked_not_guessed(self):
        active = [
            ActiveMedication(
                salt="paracetamol",
                strength="500 mg",
                medication_id="m1",
                name="Dolo",
                salt_key=None,
            ),
            ActiveMedication(
                salt="warfarin",
                strength="5 mg",
                medication_id="m2",
                name="Warf",
                salt_key="warfarin",
            ),
        ]
        result = stored_medications(active)
        assert [(m.ref, m.salt_key, m.is_new) for m in result] == [
            ("m1", None, False),
            ("m2", "warfarin", False),
        ]

    def test_typed_names_use_the_catalog_then_the_name_fallback(self):
        matches = [
            DrugMatch(),
            DrugMatch(salt_key="paracetamol", method=MatchMethod.exact, score=1.0),
        ]
        result = typed_medications(
            ["Warfarin", "Dolo 650"],
            matches,
            match_min=0.8,
            known_salts=frozenset({"warfarin"}),
        )
        assert [(m.label, m.salt_key) for m in result] == [
            ("Warfarin", "warfarin"),
            ("Dolo 650", "paracetamol"),
        ]


async def test_the_core_list_fires_on_the_famous_pairs():
    repository = core_repo()
    cases = [
        (["diclofenac", "warfarin"], "major"),
        (["aspirin", "warfarin"], "major"),
        (["nitrate-free", "x"], None),
        (["isosorbide mononitrate", "sildenafil"], "major"),
        (["escitalopram", "tramadol"], "major"),
        (["clopidogrel", "omeprazole"], "major"),
        (["ibuprofen", "telmisartan"], "moderate"),
        (["levothyroxine", "calcium carbonate"], "moderate"),
    ]
    for salts, severity in cases:
        report = await check_interactions([med("a", salts[0]), med("b", salts[1])], repository)
        got = report.findings[0].severity if report.findings else None
        assert got == severity, salts
