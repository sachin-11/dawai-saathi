"""Generate SYNTHETIC Indian-style lab reports + gold labels (CLAUDE.md §11, M12 §8).

Everything here is made up: fake patient names, fake patient / sample ids and phone numbers, a fictional
lab. No real patient data is involved, so the labels can be committed; the images are gitignored (the
generator is deterministic and reproducible).

  uv run --project apps/ai-service python evals/scripts/make_synthetic_lab.py [--count 36]

Output (evals/datasets/lab_reports/):
  images/lab_000_p1.jpg ...   one image per page: table layouts, multi-page, category ranges, mixed
                              units (mmol/L, lakhs/cumm), H / L flags, blur, rotation, noise
  labels/lab_000.json         {id, layout, pages, date, age, sex, phi_strings, results: [...]}

The expected status of every result is written BY HAND in ROW_TEMPLATES below (never derived with the
code under test), so the eval measures the real code against independent expectations.
`phi_strings` are the fake names / ids drawn on the page; the eval checks they never appear in the output.
"""

import argparse
import json
import random
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "evals" / "datasets" / "lab_reports"
FONT_CANDIDATES = (
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
)

PATIENTS = ["Asha Verma", "Rakesh Patel", "Fatima Sheikh", "Karthik Subramanian", "Neha Kapoor"]
LABS = ["Sanjeevani Diagnostics", "Prime Path Labs", "City Care Pathology"]


def T(  # noqa: N802 - a compact row constructor for the table below
    name: str,
    value: str,
    unit: str | None,
    low: float | None,
    high: float | None,
    ref_text: str | None,
    flag: str | None,
    section: str,
    code: str | None,
    status: str,
    critical: bool = False,
) -> dict[str, Any]:
    return {
        "name": name, "value_raw": value, "unit": unit, "ref_low": low, "ref_high": high,
        "ref_text": ref_text, "flag": flag, "section": section, "test_code": code,
        "status": status, "critical": critical,
    }  # fmt: skip


CAT_HBA1C = "Non-diabetic < 5.7, Pre-diabetic 5.7 - 6.4, Diabetic >= 6.5"
CAT_VITD = "Deficient < 20, Insufficient 20 - 29, Sufficient 30 - 100"

# Hand-written expectations. status: what a careful person would conclude from the printed range / flag.
ROW_TEMPLATES: list[dict[str, Any]] = [
    # --- normal
    T("Haemoglobin", "13.6", "g/dL", 12.0, 15.5, "12.0 - 15.5", "N", "CBC", "HB", "normal"),
    T("Total Leucocyte Count", "7200", "/cumm", 4000, 11000, "4000 - 11000", None, "CBC", "TLC", "normal"),
    T("Platelet Count", "2.5", "lakhs/cumm", 1.5, 4.5, "1.5 - 4.5", None, "CBC", "PLT", "normal"),
    T("SGPT (ALT)", "38", "U/L", 0, 45, "0 - 45", None, "Liver Function Test", "SGPT", "normal"),
    T("Serum Creatinine", "1.0", "mg/dL", 0.6, 1.3, "0.6 - 1.3", None, "Kidney Function Test", "CREAT", "normal"),
    T("Sodium", "139", "mmol/L", 135, 145, "135 - 145", None, "Electrolytes", "NA", "normal"),
    T("Potassium", "4.2", "mmol/L", 3.5, 5.1, "3.5 - 5.1", None, "Electrolytes", "K", "normal"),
    T("Fasting Blood Sugar", "5.2", "mmol/L", 3.9, 5.5, "3.9 - 5.5", None, "Blood Sugar", "FBS", "normal"),
    T("Urine Glucose", "Nil", None, None, None, "Nil", None, "Urine Routine", "URGLU", "normal"),
    T("Triglycerides", "120", "mg/dL", None, 150, "< 150", None, "Lipid Profile", "TG", "normal"),
    # --- outside the range
    T("Haemoglobin", "11.2", "g/dL", 12.0, 15.5, "12.0 - 15.5", "L", "CBC", "HB", "low"),
    T("TSH", "6.2", "µIU/mL", 0.4, 4.2, "0.4 - 4.2", "H", "Thyroid Profile", "TSH", "high"),
    T("Total Cholesterol", "245", "mg/dL", None, 200, "< 200", "H", "Lipid Profile", "CHOL", "high"),
    T("LDL Cholesterol", "168", "mg/dL", None, 100, "< 100", "H", "Lipid Profile", "LDL", "high"),
    T("HDL Cholesterol", "34", "mg/dL", 40, None, "> 40", "L", "Lipid Profile", "HDL", "low"),
    T("HbA1c", "7.2", "%", None, None, CAT_HBA1C, "H", "Blood Sugar", "HBA1C", "high"),
    T("Vitamin D (25-OH)", "14", "ng/mL", None, None, CAT_VITD, "L", "Vitamins", "VITD", "low"),
    T("Vitamin B12", "150", "pg/mL", 200, 900, "200 - 900", "L", "Vitamins", "B12", "low"),
    T("Uric Acid", "8.1", "mg/dL", 3.4, 7.0, "3.4 - 7.0", "H", "Kidney Function Test", "URIC", "high"),
    T("Urine Protein", "Positive", None, None, None, "Nil", None, "Urine Routine", "URPROT", "qualitative_abnormal"),
    T("Special Marker XYZ", "12", "U/L", 0, 10, "0 - 10", "H", "Other", None, "high"),
    T("Procalcitonin", "0.3", "ng/mL", None, 0.5, "< 0.5", None, "Other", None, "normal"),
    # --- critical (the hard gate: every one of these MUST be flagged critical)
    T("Haemoglobin", "6.1", "g/dL", 12.0, 15.5, "12.0 - 15.5", "L", "CBC", "HB", "critical_low", True),
    T("Platelet Count", "15000", "/cumm", 150000, 450000, "150000 - 450000", "L", "CBC", "PLT", "critical_low", True),
    T("Potassium", "6.8", "mmol/L", 3.5, 5.1, "3.5 - 5.1", "H", "Electrolytes", "K", "critical_high", True),
    T("Sodium", "118", "mmol/L", 135, 145, "135 - 145", "L", "Electrolytes", "NA", "critical_low", True),
    T("Random Blood Sugar", "620", "mg/dL", 70, 140, "70 - 140", "H", "Blood Sugar", "RBS", "critical_high", True),
    T("Fasting Blood Sugar", "2.1", "mmol/L", 3.9, 5.5, "3.9 - 5.5", "L", "Blood Sugar", "FBS", "critical_low", True),
    T("Serum Creatinine", "420", "µmol/L", 53, 115, "53 - 115", "H", "Kidney Function Test", "CREAT", "critical_high", True),
    T("Calcium", "13.8", "mg/dL", 8.5, 10.5, "8.5 - 10.5", "H", "Electrolytes", "CA", "critical_high", True),
    T("Total Leucocyte Count", "1.2", "10^3/µL", 4.0, 11.0, "4.0 - 11.0", "L", "CBC", "TLC", "critical_low", True),
]  # fmt: skip

CRITICAL_TEMPLATES = [t for t in ROW_TEMPLATES if t["critical"]]
OTHER_TEMPLATES = [t for t in ROW_TEMPLATES if not t["critical"]]


def build_case(index: int) -> dict[str, Any]:
    """Deterministic case `index`: 6-12 rows; every third report holds a critical value, and the
    critical templates cycle so each one appears more than once in 36 reports."""
    rng = random.Random(7000 + index)  # noqa: S311 - not security related
    rows = rng.sample(OTHER_TEMPLATES, rng.randint(5, 10))
    if index % 3 == 0:
        rows.insert(
            rng.randint(0, len(rows)), CRITICAL_TEMPLATES[(index // 3) % len(CRITICAL_TEMPLATES)]
        )
    # one test name appears at most once in a report; a critical row always wins over a normal one
    critical_names = {r["name"].casefold() for r in rows if r["critical"]}
    seen: set[str] = set()
    unique = []
    for row in rows:
        key = row["name"].casefold()
        if key in seen or (key in critical_names and not row["critical"]):
            continue
        seen.add(key)
        unique.append(row)
    layout = ("simple", "categories", "multipage", "mixed")[index % 4]
    pages = 2 if layout == "multipage" else 1
    patient = rng.choice(PATIENTS)
    patient_id = f"PID-{rng.randint(100000, 999999)}"
    sample_id = f"SMP{rng.randint(10**7, 10**8 - 1)}"
    phone = f"98{rng.randint(10**7, 10**8 - 1)}"
    return {
        "id": f"lab_{index:03d}",
        "layout": layout,
        "pages": pages,
        "date": f"2026-{rng.randint(1, 11):02d}-{rng.randint(1, 28):02d}",
        "age": rng.choice([None, 34, 45, 58, 67]),
        "sex": rng.choice([None, "m", "f"]),
        "lab": rng.choice(LABS),
        "results": unique,
        "phi_strings": [patient, patient_id, sample_id, phone],
        "patient": patient,
        "patient_id": patient_id,
        "sample_id": sample_id,
        "phone": phone,
    }


def _font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def render(case: dict[str, Any], rng: random.Random) -> list[Image.Image]:
    """One image per page: header with FAKE patient data, a results table, light distortion."""
    rows = case["results"]
    per_page = -(-len(rows) // case["pages"])
    pages: list[Image.Image] = []
    title, body, small = _font(30), _font(20), _font(16)
    for page_no in range(case["pages"]):
        image = Image.new("RGB", (900, 1250), "white")
        draw = ImageDraw.Draw(image)
        draw.text((40, 30), case["lab"], fill="black", font=title)
        draw.text(
            (40, 80),
            f"Patient: {case['patient']}    ID: {case['patient_id']}    Sample: {case['sample_id']}",
            fill="black", font=small,
        )  # fmt: skip
        age = f"{case['age']} Y" if case["age"] else "-"
        sex = {"m": "Male", "f": "Female"}.get(case["sex"] or "", "-")
        draw.text(
            (40, 105),
            f"Age/Sex: {age} / {sex}   Phone: {case['phone']}   Date: {case['date']}",
            fill="black", font=small,
        )  # fmt: skip
        draw.line((40, 140, 860, 140), fill="black", width=2)
        draw.text((40, 150), "TEST", fill="black", font=body)
        draw.text((330, 150), "RESULT", fill="black", font=body)
        draw.text((470, 150), "UNIT", fill="black", font=body)
        draw.text((590, 150), "REFERENCE RANGE", fill="black", font=body)
        y, section = 190, None
        for row in rows[page_no * per_page : (page_no + 1) * per_page]:
            if row["section"] != section:
                section = row["section"]
                draw.text((40, y), section.upper(), fill="black", font=body)
                y += 32
            draw.text((50, y), row["name"][:34], fill="black", font=body)
            flag = f" {row['flag']}" if row["flag"] in ("H", "L") else ""
            draw.text((330, y), f"{row['value_raw']}{flag}", fill="black", font=body)
            draw.text((470, y), row["unit"] or "", fill="black", font=small)
            draw.text((590, y), (row["ref_text"] or "")[:44], fill="black", font=small)
            y += 36
        draw.text((40, 1200), f"Page {page_no + 1} of {case['pages']}", fill="gray", font=small)
        # distortion: slight rotation, blur on some, noise
        image = image.rotate(rng.uniform(-2.0, 2.0), expand=False, fillcolor="white")
        if case["id"][-1] in "37":
            image = image.filter(ImageFilter.GaussianBlur(radius=1.2))
        pixels = image.load()
        assert pixels is not None  # noqa: S101
        for _ in range(900):
            x, yy = rng.randrange(image.width), rng.randrange(image.height)
            pixels[x, yy] = (rng.randrange(150, 255),) * 3
        pages.append(image)
    return pages


def gold_extraction(case: dict[str, Any]) -> dict[str, Any]:
    """What a PERFECT model answers for this case: only what is printed (no derived field)."""

    def f(value: Any, confidence: float = 0.95) -> dict[str, Any]:
        return {"value": value, "confidence": confidence if value is not None else 0.0}

    return {
        "kind": "lab_report",
        "is_lab_report": True,
        "image_quality": "good",
        "report_date": f(case["date"]),
        "patient_age": f(case["age"]),
        "patient_sex": f(case["sex"]),
        "results": [
            {
                "raw_test_name": f(row["name"]),
                "value_raw": f(row["value_raw"]),
                "unit": f(row["unit"]),
                "lab_ref_low": f(row["ref_low"]),
                "lab_ref_high": f(row["ref_high"]),
                "lab_ref_text": f(row["ref_text"]),
                "lab_flag": f(row["flag"], 0.9),
                "section": row["section"],
            }
            for row in case["results"]
        ],
        "overall_confidence": 0.92,
        "notes_for_user": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=36)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    (args.out / "images").mkdir(parents=True, exist_ok=True)
    (args.out / "labels").mkdir(parents=True, exist_ok=True)
    for index in range(args.count):
        case = build_case(index)
        for number, page in enumerate(render(case, random.Random(9000 + index)), start=1):  # noqa: S311
            page.save(args.out / "images" / f"{case['id']}_p{number}.jpg", quality=85)
        label = {
            k: v
            for k, v in case.items()
            if k not in ("patient", "patient_id", "sample_id", "phone")
        }
        (args.out / "labels" / f"{case['id']}.json").write_text(
            json.dumps(label, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    criticals = sum(1 for i in range(args.count) for r in build_case(i)["results"] if r["critical"])
    print(f"wrote {args.count} reports to {args.out} ({criticals} gold-critical results)")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
