"""Catalog normalisers (M8): salt, strength, form + release, brand key, product names, Devanagari."""

import pytest

from app.catalog.normalise import (
    brand_key,
    normalise_salt,
    parse_form,
    parse_product_name,
    parse_strength,
    split_salts,
    strength_canon,
    total_amount,
)
from app.catalog.translit import has_devanagari, to_roman


class TestStrength:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("650 mg", "650mg"),
            ("650MG", "650mg"),
            ("0.5 g", "500mg"),
            ("1 g", "1000mg"),
            ("1 gm", "1000mg"),
            ("0.5 mg", "0.5mg"),
            ("500 mcg", "500mcg"),
            ("500 ug", "500mcg"),
            ("500 µg", "500mcg"),
            ("100 IU", "100iu"),
            ("100 units", "100iu"),
            ("5 ml", "5ml"),
            ("2%", "2%"),
            ("2.5 %", "2.5%"),
            ("125 mg/5 ml", "125mg/5ml"),
            ("250mg/5ml", "250mg/5ml"),
            ("100 IU/ml", "100iu/1ml"),
            ("1 g/5 ml", "1000mg/5ml"),
            ("5 mg per ml", "5mg/1ml"),
            ("10,5 mg", "10.5mg"),
            ("Tab Dolo 650 mg 1-0-1", "650mg"),
        ],
    )
    def test_canonical_form(self, text, expected):
        assert strength_canon(text) == expected

    @pytest.mark.parametrize("text", [None, "", "mg", "650", "Dolo", "0 mg", "six mg", "5 gel"])
    def test_no_strength(self, text):
        assert parse_strength(text) is None

    def test_total_of_a_combination_is_the_way_prescriptions_write_it(self):
        assert total_amount("500mg+125mg") == "625mg"
        assert total_amount("5mg+40mg") == "45mg"
        assert total_amount("500mg") is None
        assert total_amount("125mg/5ml+10mg") is None
        assert total_amount("500mg+10mcg") is None


class TestSalts:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Paracetamol", "paracetamol"),
            ("PARACETAMOL IP", "paracetamol"),
            ("Acetaminophen", "paracetamol"),
            ("Amoxycillin", "amoxicillin"),
            ("Amoxycillin Trihydrate", "amoxicillin"),
            ("Amlodipine Besylate", "amlodipine"),
            ("Metformin Hydrochloride", "metformin"),
            ("Metformin HCl", "metformin"),
            ("Cetirizine Dihydrochloride", "cetirizine"),
            ("Chlorpheniramine Maleate", "chlorpheniramine"),
            ("Pantoprazole Sodium", "pantoprazole"),
            ("Atorvastatin Calcium", "atorvastatin"),
            ("Potassium Clavulanate", "clavulanic acid"),
            ("Clavulanic Acid", "clavulanic acid"),
            ("Vitamin D3", "cholecalciferol"),
            ("Vit B12", "cyanocobalamin"),
            ("Cholecalciferol (Vitamin D3)", "cholecalciferol"),
            ("पैरासिटामोल", "paracetamol"),
            ("  ", None),
            ("IP", None),
        ],
    )
    def test_normalise_salt(self, raw, expected):
        assert normalise_salt(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        [
            "Diclofenac Sodium",  # sodium is NOT stripped in general
            "Diclofenac Potassium",
            "Metoprolol Succinate",  # different release form from tartrate
            "Metoprolol Tartrate",
            "Levothyroxine Sodium",
        ],
    )
    def test_conservative_forms_are_kept(self, raw):
        assert normalise_salt(raw) == raw.lower()

    def test_diclofenac_sodium_and_potassium_stay_different(self):
        assert normalise_salt("Diclofenac Sodium") != normalise_salt("Diclofenac Potassium")

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Amoxycillin + Clavulanic Acid", ["amoxicillin", "clavulanic acid"]),
            ("Amoxycillin and Potassium Clavulanate", ["amoxicillin", "clavulanic acid"]),
            ("Paracetamol, Caffeine", ["paracetamol", "caffeine"]),
            ("Telmisartan & Amlodipine", ["telmisartan", "amlodipine"]),
            ("Amoxicillin/Clavulanic Acid", ["amoxicillin", "clavulanic acid"]),
            ("Paracetamol + Paracetamol", ["paracetamol"]),
            ("Metformin", ["metformin"]),
        ],
    )
    def test_split_combinations(self, raw, expected):
        assert split_salts(raw) == expected


class TestFormAndRelease:
    @pytest.mark.parametrize(
        ("text", "form", "release"),
        [
            ("Tablet", "tablet", "ir"),
            ("Tab", "tablet", "ir"),
            ("Film coated tablet", "tablet", "ir"),
            ("Tablets IP", "tablet", "ir"),
            ("Capsule", "capsule", "ir"),
            ("Soft gelatin capsules", "capsule", "ir"),
            ("Metformin SR tablet", "tablet", "sr"),
            ("Tablet ER", "tablet", "er"),
            ("Tablet XR", "tablet", "xr"),
            ("Metoprolol XL", "other", "na"),  # no form word: never guessed
            ("Tablet CR", "tablet", "cr"),
            ("Tablet MR", "tablet", "mr"),
            ("Extended-release tablets", "tablet", "xr"),
            ("Sustained release tablets", "tablet", "sr"),
            ("Gastro-resistant tablets", "tablet", "dr"),
            ("Enteric coated tablet", "tablet", "dr"),
            ("Syrup", "syrup", "na"),
            ("Oral solution", "syrup", "na"),
            ("Dry syrup", "suspension", "na"),
            ("Oral suspension", "suspension", "na"),
            ("Injection", "injection", "na"),
            ("Insulin pen", "injection", "na"),
            ("Oral drops", "drops", "na"),
            ("Cream", "cream", "na"),
            ("Gel", "gel", "na"),
            ("Inhaler", "inhaler", "na"),
            ("Rotacaps", "inhaler", "na"),
            ("Eye drops", "other", "na"),
            ("Ear drops", "other", "na"),
            ("Chewable tablet", "other", "na"),
            ("Dispersible tablet", "other", "na"),
            ("Orally disintegrating tablet", "other", "na"),
            ("Ointment", "other", "na"),
            ("Powder", "other", "na"),
            (None, "other", "na"),
            ("", "other", "na"),
        ],
    )
    def test_cases(self, text, form, release):
        assert parse_form(text) == (form, release)

    def test_modified_release_is_never_the_plain_form(self):
        assert parse_form("Metformin tablet")[1] != parse_form("Metformin SR tablet")[1]

    def test_conflicting_release_words_become_a_generic_modified_release(self):
        assert parse_form("ER SR tablet") == ("tablet", "mr")


class TestBrandKey:
    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("Dolo 650", "dolo650"),
            ("dolo650", "dolo650"),
            ("Dolo-650", "dolo650"),
            ("DOLO 650 TAB", "dolo650"),
            ("Tab. Dolo 650", "dolo650"),
            ("Tab Dolo-650", "dolo650"),
            ("Cap. Omez", "omez"),
            ("Syp. Ascoril", "ascoril"),
            ("Telma-AM", "telmaam"),
            ("Tabcin", "tabcin"),  # "tab" prefix only when it is a separate word
            ("Augmentin 625 Duo", "augmentin625duo"),
            ("डोलो 650", "dolo650"),
            ("डोलो", "dolo"),
        ],
    )
    def test_cases(self, name, expected):
        assert brand_key(name) == expected


class TestProductNames:
    @pytest.mark.parametrize(
        ("name", "salt", "strength", "form", "release"),
        [
            ("Paracetamol Tablets IP 500 mg", "paracetamol", "500mg", "tablet", "ir"),
            ("Atorvastatin Tablets IP 10 mg", "atorvastatin", "10mg", "tablet", "ir"),
            ("Metformin Hydrochloride SR Tablets IP 500 mg", "metformin", "500mg", "tablet", "sr"),
            ("Metformin Hydrochloride Tablets IP 500 mg", "metformin", "500mg", "tablet", "ir"),
            (
                "Amoxycillin 500mg + Clavulanic Acid 125mg Tablets",
                "amoxicillin+clavulanic acid",
                "500mg+125mg",
                "tablet",
                "ir",
            ),
            (
                "Amoxycillin and Potassium Clavulanate Tablets IP 500 mg + 125 mg",
                "amoxicillin+clavulanic acid",
                "500mg+125mg",
                "tablet",
                "ir",
            ),
            (
                "Amlodipine and Telmisartan Tablets 5mg+40mg",
                "amlodipine+telmisartan",
                "5mg+40mg",
                "tablet",
                "ir",
            ),
            (
                "Telmisartan 40 mg + Amlodipine 5 mg Tablets",
                "amlodipine+telmisartan",
                "5mg+40mg",
                "tablet",
                "ir",
            ),
            (
                "Paracetamol Oral Suspension IP 250mg/5ml",
                "paracetamol",
                "250mg/5ml",
                "suspension",
                "na",
            ),
            ("Amoxicillin Dry Syrup 125mg/5ml", "amoxicillin", "125mg/5ml", "suspension", "na"),
            ("Cetirizine Syrup 5 mg/5 ml", "cetirizine", "5mg/5ml", "syrup", "na"),
            (
                "Insulin Glargine Injection 100 IU/ml",
                "insulin glargine",
                "100iu/1ml",
                "injection",
                "na",
            ),
            ("Omeprazole Capsules IP 20 mg", "omeprazole", "20mg", "capsule", "ir"),
            (
                "Pantoprazole Gastro-resistant Tablets IP 40 mg",
                "pantoprazole",
                "40mg",
                "tablet",
                "dr",
            ),
            ("Clotrimazole Cream IP 1% w/w", "clotrimazole", "1%", "cream", "na"),
            ("Diclofenac Sodium Tablets IP 50 mg", "diclofenac sodium", "50mg", "tablet", "ir"),
            ("Folic Acid Tablets IP 5 mg", "folic acid", "5mg", "tablet", "ir"),
            (
                "Calcium 500 mg + Vitamin D3 250 IU Tablets",
                "calcium+cholecalciferol",
                "500mg+250iu",
                "tablet",
                "ir",
            ),
        ],
    )
    def test_parsed(self, name, salt, strength, form, release):
        parsed = parse_product_name(name)
        assert parsed is not None, name
        assert (parsed.salt_key, parsed.strength_key, parsed.form_key, parsed.release_type) == (
            salt,
            strength,
            form,
            release,
        )

    @pytest.mark.parametrize(
        "name",
        [
            "Dolo 650",  # a brand, no composition
            "Paracetamol Tablets IP",  # no strength: never guessed
            "Amoxycillin + Clavulanic Acid Tablets 625 mg",  # one strength for two salts
            "Tablets 500 mg",  # no salt at all
            "",
        ],
    )
    def test_rejected_rather_than_guessed(self, name):
        assert parse_product_name(name) is None


class TestDevanagari:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("डोलो", "dolo"),
            ("डोलो 650", "dolo 650"),
            ("पैरासिटामोल", "pairasitamol"),
            ("क्रोसिन", "krosin"),
            ("०१२", "012"),
            ("Dolo 650", "Dolo 650"),
        ],
    )
    def test_to_roman(self, text, expected):
        assert to_roman(text) == expected

    def test_detection(self):
        assert has_devanagari("डोलो") and not has_devanagari("dolo")
