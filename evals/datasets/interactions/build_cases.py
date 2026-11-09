"""Writes `cases.jsonl` for the interaction eval (M11). The GOLD answers below are written by hand, NOT
computed from `data/seed/interactions_core.csv`, so a wrong or deleted row in the data shows up as a
failing case (recall) and a wrongly added row as a spurious finding (hallucination gate).

    uv run --project apps/ai-service python evals/datasets/interactions/build_cases.py

Case shape
  checker cases   {"id","category","medicines":[{"label","salt_key"|null,"new":true}],"only_new":true,
                   "expect":{"findings":[{"type","salts":[a,b],"severity"|null,"effect"|null}],
                             "unchecked":[labels]}}
  question cases  {"id","category":"question","text","language","stored":[{"name","salt_key"}],"expect":{...}}
All brand names in question cases are in the committed curated brand list.
"""

import json
from pathlib import Path

OUT = Path(__file__).with_name("cases.jsonl")
CASES: list[dict] = []


def finding(a: str, b: str, severity: str, effect: str) -> dict:
    x, y = sorted((a, b))
    return {"type": "interaction", "salts": [x, y], "severity": severity, "effect": effect}


def dup(salt: str) -> dict:
    return {"type": "duplicate_ingredient", "salts": [salt, salt], "severity": None, "effect": None}


def meds(*items: str | tuple) -> list[dict]:
    """`"warfarin"` -> salt name used as label and key; `("Dolo", "paracetamol")`; `("Mystery", None)`;
    a 3-tuple's last item False marks a STORED medicine."""
    result = []
    for item in items:
        if isinstance(item, str):
            result.append({"label": item, "salt_key": item, "new": True})
        else:
            label, key, *rest = item
            result.append({"label": label, "salt_key": key, "new": rest[0] if rest else True})
    return result


def add(case_id: str, category: str, medicines: list[dict], findings: list[dict], **extra) -> None:
    expect = {"findings": findings, "unchecked": extra.pop("unchecked", [])}
    CASES.append(
        {
            "id": case_id,
            "category": category,
            "medicines": medicines,
            "only_new": extra.pop("only_new", True),
            "expect": expect,
            **extra,
        }
    )


# --------------------------------------------------------------------------- known pairs
PAIRS = [
    ("warfarin", "ibuprofen", "major", "bleeding"),
    ("warfarin", "diclofenac", "major", "bleeding"),
    ("acenocoumarol", "naproxen", "major", "bleeding"),
    ("warfarin", "aspirin", "major", "bleeding"),
    ("warfarin", "clopidogrel", "major", "bleeding"),
    ("apixaban", "ibuprofen", "major", "bleeding"),
    ("rivaroxaban", "aspirin", "major", "bleeding"),
    ("warfarin", "fluconazole", "major", "increased_drug_level"),
    ("warfarin", "metronidazole", "major", "increased_drug_level"),
    ("warfarin", "amiodarone", "major", "increased_drug_level"),
    ("warfarin", "ciprofloxacin", "moderate", "increased_drug_level"),
    ("warfarin", "paracetamol", "moderate", "increased_drug_level"),
    ("warfarin", "rifampicin", "moderate", "reduced_drug_effect"),
    ("ibuprofen", "diclofenac", "moderate", "stomach_ulcer"),
    ("ibuprofen", "aspirin", "moderate", "stomach_ulcer"),
    ("ibuprofen", "telmisartan", "moderate", "kidney_bp"),
    ("diclofenac", "ramipril", "moderate", "kidney_bp"),
    ("ibuprofen", "furosemide", "moderate", "kidney_bp"),
    ("naproxen", "methotrexate", "major", "increased_drug_level"),
    ("ibuprofen", "lithium", "major", "increased_drug_level"),
    ("diclofenac", "sertraline", "moderate", "bleeding"),
    ("ibuprofen", "prednisolone", "moderate", "stomach_ulcer"),
    ("ibuprofen", "ciprofloxacin", "moderate", "seizure_risk"),
    ("clopidogrel", "omeprazole", "major", "reduced_drug_effect"),
    ("clopidogrel", "esomeprazole", "major", "reduced_drug_effect"),
    ("aspirin", "clopidogrel", "minor", "bleeding"),
    ("sildenafil", "isosorbide mononitrate", "major", "low_blood_pressure"),
    ("tadalafil", "glyceryl trinitrate", "major", "low_blood_pressure"),
    ("sildenafil", "tamsulosin", "moderate", "low_blood_pressure"),
    ("ramipril", "spironolactone", "moderate", "hyperkalemia"),
    ("losartan", "spironolactone", "moderate", "hyperkalemia"),
    ("enalapril", "telmisartan", "moderate", "kidney_bp"),
    ("lisinopril", "lithium", "moderate", "increased_drug_level"),
    ("escitalopram", "tramadol", "major", "serotonin_syndrome"),
    ("sertraline", "linezolid", "major", "serotonin_syndrome"),
    ("tramadol", "linezolid", "major", "serotonin_syndrome"),
    ("fluoxetine", "sertraline", "major", "serotonin_syndrome"),
    ("alprazolam", "tramadol", "major", "cns_depression"),
    ("diazepam", "morphine", "major", "cns_depression"),
    ("codeine", "gabapentin", "moderate", "cns_depression"),
    ("alprazolam", "itraconazole", "major", "increased_drug_level"),
    ("simvastatin", "clarithromycin", "major", "muscle_toxicity"),
    ("simvastatin", "ketoconazole", "major", "muscle_toxicity"),
    ("simvastatin", "gemfibrozil", "major", "muscle_toxicity"),
    ("atorvastatin", "clarithromycin", "moderate", "muscle_toxicity"),
    ("simvastatin", "amlodipine", "moderate", "muscle_toxicity"),
    ("ciprofloxacin", "calcium carbonate", "moderate", "reduced_absorption"),
    ("levofloxacin", "ferrous sulfate", "moderate", "reduced_absorption"),
    ("ciprofloxacin", "glimepiride", "moderate", "glucose_control"),
    ("levofloxacin", "prednisolone", "moderate", "tendon_risk"),
    ("doxycycline", "aluminium hydroxide", "moderate", "reduced_absorption"),
    ("levothyroxine", "calcium carbonate", "moderate", "reduced_absorption"),
    ("levothyroxine", "ferrous sulfate", "moderate", "reduced_absorption"),
    ("glimepiride", "propranolol", "moderate", "hypoglycaemia_masked"),
    ("prednisolone", "metformin", "moderate", "glucose_control"),
    ("metoprolol", "verapamil", "major", "slow_heart_rate"),
    ("atenolol", "diltiazem", "major", "slow_heart_rate"),
    ("digoxin", "amiodarone", "major", "increased_drug_level"),
    ("digoxin", "furosemide", "moderate", "increased_drug_level"),
    ("methotrexate", "trimethoprim", "major", "toxicity"),
    ("allopurinol", "azathioprine", "major", "toxicity"),
    ("carbamazepine", "erythromycin", "major", "increased_drug_level"),
    ("domperidone", "clarithromycin", "major", "qt_prolongation"),
    ("hydroxychloroquine", "azithromycin", "moderate", "qt_prolongation"),
    ("meropenem", "valproic acid", "major", "seizure_risk"),
]
for number, (a, b, severity, effect) in enumerate(PAIRS, 1):
    add(f"pair-{number:02d}", "pair", meds(a, b), [finding(a, b, severity, effect)])

# the same pair in the other order must give the same answer
add(
    "pair-reversed-1",
    "pair",
    meds("ibuprofen", "warfarin"),
    [finding("warfarin", "ibuprofen", "major", "bleeding")],
)
add(
    "pair-reversed-2",
    "pair",
    meds("telmisartan", "diclofenac"),
    [finding("diclofenac", "telmisartan", "moderate", "kidney_bp")],
)

# --------------------------------------------------------------------------- no row (NOT "safe")
NO_ROW = [
    ("paracetamol", "pantoprazole"),
    ("amlodipine", "atorvastatin"),
    ("telmisartan", "metformin"),
    ("cetirizine", "montelukast"),
    ("azithromycin", "paracetamol"),
    ("amoxicillin", "pantoprazole"),
    ("metformin", "glimepiride"),
    ("ondansetron", "paracetamol"),
    ("ibuprofen", "pantoprazole"),
    ("levothyroxine", "pantoprazole"),
    ("atorvastatin", "metformin"),
    ("losartan", "amlodipine"),
    ("cefixime", "paracetamol"),
    ("rosuvastatin", "aspirin"),
    ("metoprolol", "amlodipine"),
]
for number, (a, b) in enumerate(NO_ROW, 1):
    add(f"norow-{number:02d}", "no_row", meds(a, b), [])

# --------------------------------------------------------------------------- combination products
add("combo-1", "combination", meds(("Combiflam", "ibuprofen+paracetamol"), ("Warf", "warfarin")),
    [finding("ibuprofen", "warfarin", "major", "bleeding"), finding("paracetamol", "warfarin", "moderate", "increased_drug_level")])  # fmt: skip
add("combo-2", "combination", meds(("Telma-AM", "amlodipine+telmisartan"), ("Brufen", "ibuprofen")),
    [finding("ibuprofen", "telmisartan", "moderate", "kidney_bp")])  # fmt: skip
add("combo-3", "combination", meds(("Telma-AM", "amlodipine+telmisartan")), [])
add("combo-4", "combination", meds(("Combiflam", "ibuprofen+paracetamol")), [])
add("combo-5", "combination", meds(("Shelcal", "calcium carbonate+cholecalciferol"), ("Eltroxin", "levothyroxine")),
    [finding("calcium carbonate", "levothyroxine", "moderate", "reduced_absorption")])  # fmt: skip
add("combo-6", "combination", meds(("Telma-AM", "amlodipine+telmisartan"), ("Simvas", "simvastatin")),
    [finding("amlodipine", "simvastatin", "moderate", "muscle_toxicity")])  # fmt: skip
add("combo-7", "combination", meds(("Combiflam", "ibuprofen+paracetamol"), ("Ecosprin", "aspirin")),
    [finding("aspirin", "ibuprofen", "moderate", "stomach_ulcer")])  # fmt: skip
add("combo-8", "combination", meds(("Ultracet", "paracetamol+tramadol"), ("Nexito", "escitalopram")),
    [finding("escitalopram", "tramadol", "major", "serotonin_syndrome")])  # fmt: skip
add(
    "combo-9",
    "combination",
    meds(("Dolo", "paracetamol"), ("Ultracet", "paracetamol+tramadol")),
    [dup("paracetamol")],
)
add("combo-10", "combination", meds(("Glucomet-G", "glimepiride+metformin"), ("Ciplox", "ciprofloxacin")),
    [finding("ciprofloxacin", "glimepiride", "moderate", "glucose_control")])  # fmt: skip

# --------------------------------------------------------------------------- duplicate ingredients
add(
    "dup-01",
    "duplicate",
    meds(("Dolo 650", "paracetamol"), ("Crocin 500", "paracetamol")),
    [dup("paracetamol")],
)
add(
    "dup-02",
    "duplicate",
    meds(("Combiflam", "ibuprofen+paracetamol"), ("Dolo 650", "paracetamol")),
    [dup("paracetamol")],
)
add(
    "dup-03",
    "duplicate",
    meds(("Amlong", "amlodipine"), ("Telma-AM", "amlodipine+telmisartan")),
    [dup("amlodipine")],
)
add(
    "dup-04",
    "duplicate",
    meds(("Voveran", "diclofenac"), ("Dynapar", "diclofenac")),
    [dup("diclofenac")],
)
add(
    "dup-05",
    "duplicate",
    meds(("Dolo 650", "paracetamol"), ("Crocin 500", "paracetamol"), ("Calpol", "paracetamol")),
    [dup("paracetamol")],
)
add(
    "dup-06",
    "duplicate",
    meds(("New Dolo", "paracetamol", True), ("Old Crocin", "paracetamol", False)),
    [dup("paracetamol")],
)
add(
    "dup-07",
    "duplicate",
    meds(("Brufen", "ibuprofen"), ("Combiflam", "ibuprofen+paracetamol")),
    [dup("ibuprofen")],
)
add("dup-08", "duplicate", meds(("Ecosprin", "aspirin"), ("Disprin", "aspirin")), [dup("aspirin")])
add(
    "dup-09",
    "duplicate",
    meds(("Pantop", "pantoprazole"), ("Pan", "pantoprazole")),
    [dup("pantoprazole")],
)
add("dup-10", "duplicate", meds(("Dolo 650", "paracetamol"), ("Combiflam", "ibuprofen+paracetamol"), ("Warf", "warfarin")),
    [dup("paracetamol"), finding("ibuprofen", "warfarin", "major", "bleeding"), finding("paracetamol", "warfarin", "moderate", "increased_drug_level")])  # fmt: skip
add("dup-11", "duplicate", meds(("Dolo 650", "paracetamol"), ("Metformin", "metformin")), [])
add(
    "dup-12",
    "duplicate",
    meds(("Dolo 650", "paracetamol", False), ("Crocin 500", "paracetamol", False)),
    [],
)  # two OLD ones: not announced again
add(
    "dup-13",
    "duplicate",
    meds(("Dolo 650", "paracetamol", False), ("Crocin 500", "paracetamol", False)),
    [dup("paracetamol")],
    only_new=False,
)  # CHECK: everything
add(
    "dup-14",
    "duplicate",
    meds(("Dolo 650", "paracetamol"), ("Dolo 650", "paracetamol")),
    [],
    note="the same medicine twice is not two products",
)  # same label, different ref -> see below

# --------------------------------------------------------------------------- unmatched / unsure medicines
add(
    "unchk-1",
    "unchecked",
    meds(("Mystery Syrup", None), ("Dolo 650", "paracetamol")),
    [],
    unchecked=["Mystery Syrup"],
)
add("unchk-2", "unchecked", meds(("Zzqx", None), ("Warf", "warfarin"), ("Brufen", "ibuprofen")),
    [finding("ibuprofen", "warfarin", "major", "bleeding")], unchecked=["Zzqx"])  # fmt: skip
add(
    "unchk-3",
    "unchecked",
    meds(("Unknown A", None), ("Unknown B", None)),
    [],
    unchecked=["Unknown A", "Unknown B"],
)
add(
    "unchk-4",
    "unchecked",
    meds(("Old Syrup", None, False), ("Dolo 650", "paracetamol")),
    [],
    unchecked=["Old Syrup"],
)
add("unchk-5", "unchecked", meds(("Mystery", None)), [], unchecked=["Mystery"])

# --------------------------------------------------------------------------- stored vs new
add("stored-1", "stored", meds(("Warf", "warfarin", False), ("Brufen", "ibuprofen", True)),
    [finding("ibuprofen", "warfarin", "major", "bleeding")])  # fmt: skip
add(
    "stored-2", "stored", meds(("Warf", "warfarin", False), ("Brufen", "ibuprofen", False)), []
)  # old pair: silent
add("stored-3", "stored", meds(("Warf", "warfarin", False), ("Brufen", "ibuprofen", False)),
    [finding("ibuprofen", "warfarin", "major", "bleeding")], only_new=False)  # fmt: skip
add("stored-4", "stored", meds(("Warf", "warfarin", False), ("Eltroxin", "levothyroxine", False), ("Shelcal", "calcium carbonate", False),
                                ("Ecosprin", "aspirin", False)),
    [finding("aspirin", "warfarin", "major", "bleeding"), finding("calcium carbonate", "levothyroxine", "moderate", "reduced_absorption")],
    only_new=False)  # fmt: skip
add("stored-5", "stored", meds(("Dolo", "paracetamol", True), ("Warf", "warfarin", False)),
    [finding("paracetamol", "warfarin", "moderate", "increased_drug_level")])  # fmt: skip

# --------------------------------------------------------------------------- typed questions (graph, fake LLM)
Q = [
    # (id, text, language, stored, findings, extra)
    ("q-01", "Dolo aur Combiflam saath le sakte hain?", "hi", [], [dup("paracetamol")], {}),
    ("q-02", "Dolo aur Combiflam saath le sakte hain?", "en", [], [dup("paracetamol")], {}),
    (
        "q-03",
        "Brufen 400 aur Uniwarfin 5 saath le sakte hain?",
        "en",
        [],
        [finding("ibuprofen", "warfarin", "major", "bleeding")],
        {},
    ),
    (
        "q-04",
        "Brufen 400 aur Uniwarfin 5 saath le sakte hain?",
        "hi",
        [],
        [finding("ibuprofen", "warfarin", "major", "bleeding")],
        {},
    ),
    (
        "q-05",
        "Is it ok to take together Ecosprin 75 and Clopilet 75?",
        "en",
        [],
        [finding("aspirin", "clopidogrel", "minor", "bleeding")],
        {},
    ),
    (
        "q-06",
        "Cardace 5 aur Aldactone 25 ek saath le sakte hain?",
        "en",
        [],
        [finding("ramipril", "spironolactone", "moderate", "hyperkalemia")],
        {},
    ),
    (
        "q-07",
        "Thyronorm 50 aur Shelcal 500 saath le sakte hain?",
        "hi",
        [],
        [finding("calcium", "levothyroxine", "moderate", "reduced_absorption")],
        {},
    ),
    (
        "q-08",
        "Ciplox 500 aur Shelcal 500 saath le sakte hain?",
        "en",
        [],
        [finding("calcium", "ciprofloxacin", "moderate", "reduced_absorption")],
        {},
    ),
    (
        "q-09",
        "Telma 40 aur Brufen 400 saath le sakte hain?",
        "en",
        [],
        [finding("ibuprofen", "telmisartan", "moderate", "kidney_bp")],
        {},
    ),
    ("q-10", "Dolo 650 aur Pantop 40 saath le sakte hain?", "en", [], [], {"says_none": True}),
    ("q-11", "Dolo 650 aur Pantop 40 saath le sakte hain?", "hi", [], [], {"says_none": True}),
    ("q-12", "Glycomet 500 aur Atorva 10 saath le sakte hain?", "en", [], [], {"says_none": True}),
    ("q-13", "Zzqxfoo aur Dolo 650 saath le sakte hain?", "en", [], [], {"unchecked": ["Zzqxfoo"]}),
    (
        "q-14",
        "Brufen 400 saath le sakte hain?",
        "en",
        [{"name": "Uniwarfin 5", "salt_key": "warfarin"}],
        [finding("ibuprofen", "warfarin", "major", "bleeding")],
        {},
    ),
    (
        "q-15",
        "Dolo 650 saath le sakte hain?",
        "en",
        [{"name": "Crocin 500", "salt_key": "paracetamol"}],
        [dup("paracetamol")],
        {},
    ),
    ("q-16", "Brufen 400 saath le sakte hain?", "en", [], [], {"asks_names": True}),
    (
        "q-17",
        "Combiflam aur Ecosprin 75 saath le sakte hain?",
        "en",
        [],
        [finding("aspirin", "ibuprofen", "moderate", "stomach_ulcer")],
        {},
    ),
    ("q-18", "Storvas 10 aur Amlong 5 saath le sakte hain?", "en", [], [], {"says_none": True}),
    (
        "q-19",
        "Metolar XR 50 aur Amaryl 1 saath le sakte hain?",
        "en",
        [],
        [finding("glimepiride", "metoprolol", "moderate", "hypoglycaemia_masked")],
        {},
    ),
    (
        "q-20",
        "Lasix 40 aur Brufen 400 saath le sakte hain?",
        "hi",
        [],
        [finding("furosemide", "ibuprofen", "moderate", "kidney_bp")],
        {},
    ),
]
for qid, text, language, stored, findings, extra in Q:
    CASES.append(
        {
            "id": qid,
            "category": "question",
            "text": text,
            "language": language,
            "stored": stored,
            "expect": {"findings": findings, "unchecked": extra.get("unchecked", [])},
            "says_none": bool(extra.get("says_none")),
            "asks_names": bool(extra.get("asks_names")),
        }
    )

# "same medicine twice" is two refs with the same salt in this builder; the checker treats refs, so it
# IS a duplicate: drop the ambiguous case rather than assert something the data cannot say.
CASES[:] = [c for c in CASES if c["id"] != "dup-14"]

OUT.write_text("\n".join(json.dumps(c, ensure_ascii=False) for c in CASES) + "\n", encoding="utf-8")
print(f"{len(CASES)} cases -> {OUT}")
