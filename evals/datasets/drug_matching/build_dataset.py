"""Build `cases.jsonl`, the drug-matching evaluation set (M8). Run: python build_dataset.py

The GOLD KEYS below are written by hand (salt, strength, form, release) and are deliberately NOT
computed with the normalisers under test, so a normaliser bug cannot hide itself. Each brand is then
expanded into messy spellings. Every case says what a safe reply may contain:

  gold            the keys of the product the user means, or null for an unknown medicine
  excluded        true for medicines that must NEVER get a generic (NTI, insulin, modified release ...)
  forbid_suggestion true when the written input is unsafe to compare (wrong strength, wrong form, no
                  strength for a numberless brand, ambiguous): any suggestion is a violation
  expect_suggestion true when a safe generic exists in the catalog (reported as coverage, not gated)

All rows are SYNTHETIC. No patient data.
"""

import json
from pathlib import Path

OUT = Path(__file__).with_name("cases.jsonl")

# brand -> (salt_key, strength_key, form_key, release_type, written strength or None, excluded, expect_suggestion)
BRANDS: dict[str, tuple[str, str, str, str, str | None, bool, bool]] = {
    "Dolo 650": ("paracetamol", "650mg", "tablet", "ir", None, False, True),
    "Dolo 500": ("paracetamol", "500mg", "tablet", "ir", None, False, True),
    "Crocin 500": ("paracetamol", "500mg", "tablet", "ir", None, False, True),
    "Combiflam": ("ibuprofen+paracetamol", "400mg+325mg", "tablet", "ir", None, False, False),
    "Omez": ("omeprazole", "20mg", "capsule", "ir", "20 mg", False, False),
    "Augmentin 625 Duo": (
        "amoxicillin+clavulanic acid",
        "500mg+125mg",
        "tablet",
        "ir",
        None,
        False,
        True,
    ),
    "Azithral 500": ("azithromycin", "500mg", "tablet", "ir", None, False, True),
    "Cetzine": ("cetirizine", "10mg", "tablet", "ir", "10 mg", False, True),
    "Allegra 120": ("fexofenadine", "120mg", "tablet", "ir", None, False, False),
    "Glycomet 500": ("metformin", "500mg", "tablet", "ir", None, False, True),
    "Amlong 5": ("amlodipine", "5mg", "tablet", "ir", None, False, True),
    "Telma 40": ("telmisartan", "40mg", "tablet", "ir", None, False, False),
    "Telma-AM": ("amlodipine+telmisartan", "5mg+40mg", "tablet", "ir", None, False, False),
    "Atorva 10": ("atorvastatin", "10mg", "tablet", "ir", None, False, True),
    "Rosuvas 10": ("rosuvastatin", "10mg", "tablet", "ir", None, False, False),
    "Shelcal 500": ("calcium+cholecalciferol", "500mg+250iu", "tablet", "ir", None, False, False),
    "Uprise-D3 60K": ("cholecalciferol", "60000iu", "capsule", "ir", None, False, False),
    "Amaryl 2": ("glimepiride", "2mg", "tablet", "ir", None, False, False),
    "Losar 50": ("losartan potassium", "50mg", "tablet", "ir", None, False, False),
    "Candid": ("clotrimazole", "1%", "cream", "na", "1%", False, False),
    "Gabapin 100": ("gabapentin", "100mg", "capsule", "ir", None, False, False),
    "Metrogyl 400": ("metronidazole", "400mg", "tablet", "ir", None, False, False),
    "Zifi 200": ("cefixime", "200mg", "tablet", "ir", None, False, False),
    "Ciplox 500": ("ciprofloxacin", "500mg", "tablet", "ir", None, False, False),
    # never a generic
    "Glycomet SR 500": ("metformin", "500mg", "tablet", "sr", None, True, False),
    "Metolar XR 50": ("metoprolol succinate", "50mg", "tablet", "xr", None, True, False),
    "Pantop 40": ("pantoprazole", "40mg", "tablet", "dr", None, True, False),
    "Ecosprin 75": ("aspirin", "75mg", "tablet", "dr", None, True, False),
    "Thyronorm 50": ("levothyroxine sodium", "50mcg", "tablet", "ir", "50 mcg", True, False),
    "Eltroxin 50": ("levothyroxine sodium", "50mcg", "tablet", "ir", "50 mcg", True, False),
    "Lanoxin": ("digoxin", "0.25mg", "tablet", "ir", "0.25 mg", True, False),
    "Uniwarfin 5": ("warfarin sodium", "5mg", "tablet", "ir", None, True, False),
    "Eptoin 100": ("phenytoin sodium", "100mg", "tablet", "ir", None, True, False),
    "Tegretol 200": ("carbamazepine", "200mg", "tablet", "ir", None, True, False),
    "Lantus": ("insulin glargine", "100iu/1ml", "injection", "na", "100 IU/ml", True, False),
    "NovoRapid": ("insulin aspart", "100iu/1ml", "injection", "na", "100 IU/ml", True, False),
    "Asthalin": ("salbutamol", "100mcg", "inhaler", "na", "100 mcg", True, False),
}

UNKNOWN = [
    "Zzxq 10", "Qwertyuiop", "Mediplex Forte", "Xylofen 200", "Brandnotreal 5", "Nuvaxin", "Kolopril 25",
    "Zentrobin", "Veloxa 100", "Fictoral 50", "Pharmaxon", "Luminex 10", "Torvalex", "Dexorin 5", "Yellowpill",
]  # fmt: skip

# written generic names -> keys
SALT_WRITTEN = [
    ("Paracetamol", "500 mg", "tablet", ("paracetamol", "500mg", "tablet", "ir"), False, True),
    ("Paracetamol", "650 mg", "tablet", ("paracetamol", "650mg", "tablet", "ir"), False, True),
    ("Metformin", "500 mg", "tablet", ("metformin", "500mg", "tablet", "ir"), False, True),
    ("Metformin SR", "500 mg", "tablet", ("metformin", "500mg", "tablet", "sr"), True, False),
    ("Metformin Hydrochloride", "500 mg", "tablet", ("metformin", "500mg", "tablet", "ir"), False, True),
    ("Atorvastatin", "10 mg", "tablet", ("atorvastatin", "10mg", "tablet", "ir"), False, True),
    ("Azithromycin", "500 mg", "tablet", ("azithromycin", "500mg", "tablet", "ir"), False, True),
    ("Cetirizine", "10 mg", "tablet", ("cetirizine", "10mg", "tablet", "ir"), False, True),
    ("Amlodipine", "5 mg", "tablet", ("amlodipine", "5mg", "tablet", "ir"), False, True),
    ("Levothyroxine", "50 mcg", "tablet", ("levothyroxine sodium", "50mcg", "tablet", "ir"), True, False),
    ("पैरासिटामोल", "500 mg", "tablet", ("paracetamol", "500mg", "tablet", "ir"), False, True),
    ("Acetaminophen", "500 mg", "tablet", ("paracetamol", "500mg", "tablet", "ir"), False, True),
]  # fmt: skip

DEVANAGARI = [
    ("डोलो 650", "Dolo 650"),
    ("क्रोसिन 500", "Crocin 500"),
    ("ग्लाइकोमेट 500", "Glycomet 500"),
    ("एज़िथ्राल 500", "Azithral 500"),
    ("पैन्टोप 40", "Pantop 40"),
    ("ओमेज़", "Omez"),
    ("सेट्ज़ीन", "Cetzine"),
    ("एमलॉन्ग 5", "Amlong 5"),
    ("टेल्मा 40", "Telma 40"),
]  # fmt: skip


def typo(name: str) -> str:
    """Drop one letter from the first word of three or more letters (a realistic slip)."""
    words = name.split()
    first = words[0]
    if len(first) < 5:
        return name.replace(first, first[:-1] + first[-1] * 2, 1)
    words[0] = first[:2] + first[3:]
    return " ".join(words)


def case(category: str, name: str, strength: str | None, form: str | None, gold, **flags):
    return {
        "category": category,
        "name": name,
        "strength": strength,
        "form": form,
        "gold": None
        if gold is None
        else dict(zip(("salt_key", "strength_key", "form_key", "release_type"), gold)),
        "excluded": flags.get("excluded", False),
        "forbid_suggestion": flags.get("forbid", False),
        "expect_suggestion": flags.get("expect", False),
    }


def build() -> list[dict]:
    rows: list[dict] = []
    for brand, (salt, strength_key, form, release, written, excluded, expect) in BRANDS.items():
        gold = (salt, strength_key, form, release)
        flags = {"excluded": excluded, "expect": expect, "forbid": False}
        lowered = "".join(ch for ch in brand.lower() if ch.isalnum())
        for category, name in (
            ("brand_exact", brand),
            ("brand_squeezed", lowered),
            (
                "brand_prefixed",
                f"Tab. {brand}"
                if form == "tablet"
                else f"Cap. {brand}"
                if form == "capsule"
                else brand,
            ),
            ("brand_suffixed", f"{brand.upper()} TAB" if form == "tablet" else brand.upper()),
            ("brand_hyphen", brand.replace(" ", "-")),
            ("brand_typo", typo(brand)),
        ):
            rows.append(case(category, name, written, None, gold, **flags))

    for text, brand in DEVANAGARI:
        salt, strength_key, form, release, written, excluded, expect = BRANDS[brand]
        rows.append(
            case(
                "devanagari",
                text,
                written,
                None,
                (salt, strength_key, form, release),
                excluded=excluded,
                expect=expect,
            )
        )

    for name, strength, form, gold, excluded, expect in SALT_WRITTEN:
        rows.append(
            case("salt_written", name, strength, form, gold, excluded=excluded, expect=expect)
        )

    # The written strength contradicts the product: never compare.
    for name, strength in (("Dolo 650", "500 mg"), ("Dolo 650", "1000 mg"), ("Dolo 500", "650 mg"), ("Azithral 500", "250 mg"),
                           ("Atorva 10", "20 mg"), ("Telma 40", "80 mg"), ("Amlong 5", "10 mg"), ("Glycomet 500", "850 mg")):  # fmt: skip
        rows.append(case("wrong_strength", name, strength, None, None, forbid=True))

    # The written form contradicts the product.
    for name, form in (
        ("Dolo 650", "syrup"),
        ("Azithral 500", "injection"),
        ("Omez", "tablet"),
        ("Atorva 10", "syrup"),
    ):
        rows.append(case("wrong_form", name, None, form, None, forbid=True))

    # The form is written inside the name (typed questions, abbreviations): same rule.
    for name in (
        "Dolo 650 syrup",
        "Azithral 500 injection",
        "Atorva 10 eye drops",
        "Dolo 650 chewable tablet",
        "Omez tablets",
    ):
        rows.append(case("form_in_name", name, None, None, None, forbid=True))

    # Numberless brand and no strength written, or two strengths fit: unsafe to compare.
    for name in ("Cetzine", "Atorva", "Telma-AM", "Amaryl", "Glycomet", "Dolo", "डोलो"):
        rows.append(case("strength_unverified", name, None, None, None, forbid=True))

    # A plain prescription must not be tied to a modified-release product, or the other way round.
    rows.append(
        case(
            "release",
            "Glycomet 500",
            None,
            None,
            ("metformin", "500mg", "tablet", "ir"),
            expect=True,
        )
    )
    rows.append(
        case(
            "release",
            "Glycomet SR 500",
            None,
            None,
            ("metformin", "500mg", "tablet", "sr"),
            excluded=True,
        )
    )

    for name in UNKNOWN:
        rows.append(case("unknown", name, None, None, None, forbid=True))
    return rows


if __name__ == "__main__":
    rows = build()
    with OUT.open("w", encoding="utf-8", newline="\n") as handle:
        for index, row in enumerate(rows):
            handle.write(json.dumps({"id": f"dm_{index:03d}", **row}, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} cases to {OUT}")
