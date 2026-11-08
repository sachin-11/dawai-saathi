"""Generate SYNTHETIC Indian-style prescription images + gold labels (CLAUDE.md §11, M7 §9).

Everything here is made up: fake doctor / patient names, fake phone numbers, a fictional clinic.
No real patient data is involved, so the labels can be committed; the images are gitignored (they
are reproducible: the generator is deterministic).

  uv run --project apps/ai-service python evals/scripts/make_synthetic_rx.py [--count 24]

Output (evals/datasets/prescriptions/):
  images/rx_000.jpg ...   the page: layout, handwriting-style font, rotation, blur, noise, a
                          crossed-out decoy line, and (in some cases) one scribbled-out medicine
  labels/rx_000.json      {id, layout, gold: <PrescriptionExtraction-shaped>, unreadable_indexes,
                          phi_strings}

`phi_strings` are the fake names/phones drawn on the page. They are NOT part of the gold extraction
(the schema has no such fields); the eval uses them to check nothing leaks into the output.

Fonts: handwriting-style fonts are not committed (licences differ). The generator looks, in order, at
evals/assets/fonts/*.ttf (drop an OFL handwriting font such as Caveat there), then well-known system
fonts, then Pillow's built-in font. It prints which one it used.
"""

import argparse
import json
import random
import re
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "evals" / "datasets" / "prescriptions"
FONT_DIR = ROOT / "evals" / "assets" / "fonts"
SYSTEM_FONTS = (
    "C:/Windows/Fonts/Inkfree.ttf",
    "C:/Windows/Fonts/segoesc.ttf",
    "C:/Windows/Fonts/comic.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
)

# Fictional people and places (never real).
PATIENTS = ["Ramesh Kumar", "Sunita Devi", "Mohammed Iqbal", "Lakshmi Narayanan", "Gurpreet Singh"]
DOCTORS = ["Dr. A. K. Verma", "Dr. Meena Iyer", "Dr. S. Rao", "Dr. P. Banerjee"]
CLINICS = ["Shanti Care Clinic", "Arogya Polyclinic", "City Health Centre"]

PREFIX = {
    "tablet": "Tab.",
    "capsule": "Cap.",
    "syrup": "Syp.",
    "injection": "Inj.",
    "drops": "Drops",
    "cream": "Oint.",
}

# name, form, strength written separately (or None), dose, how the frequency is written, gold per
# day, gold timings, as_needed, food (gold), how food is written, days (gold), how days are written
SPECS: list[dict[str, Any]] = [
    {
        "name": "Dolo 650",
        "form": "tablet",
        "strength": None,
        "dose": "1 tablet",
        "code": "1-0-1",
        "per_day": 2,
        "timings": ["morning", "night"],
        "food": "after",
        "food_text": "(after food)",
        "days": 5,
        "days_text": "x 5 days",
    },
    {
        "name": "Pantop 40",
        "form": "tablet",
        "strength": None,
        "dose": "1 tablet",
        "code": "1-0-0",
        "per_day": 1,
        "timings": ["morning"],
        "food": "before",
        "food_text": "AC",
        "days": 10,
        "days_text": "x 10 days",
    },
    {
        "name": "Azithral 500",
        "form": "tablet",
        "strength": "500 mg",
        "dose": "1 tablet",
        "code": "OD",
        "per_day": 1,
        "timings": [],
        "food": "after",
        "food_text": "PC",
        "days": 3,
        "days_text": "x 3 days",
    },
    {
        "name": "Cetzine",
        "form": "tablet",
        "strength": "10 mg",
        "dose": "1 tablet",
        "code": "HS",
        "per_day": 1,
        "timings": ["night"],
        "food": None,
        "food_text": "",
        "days": 7,
        "days_text": "x 1 week",
    },
    {
        "name": "Augmentin 625",
        "form": "tablet",
        "strength": None,
        "dose": "1 tablet",
        "code": "BD",
        "per_day": 2,
        "timings": [],
        "food": "after",
        "food_text": "PC",
        "days": 5,
        "days_text": "x 5 days",
    },
    {
        "name": "Ascoril",
        "form": "syrup",
        "strength": None,
        "dose": "5 ml",
        "code": "TDS",
        "per_day": 3,
        "timings": [],
        "food": None,
        "food_text": "",
        "days": 5,
        "days_text": "x 5 days",
    },
    {
        "name": "Crocin 500",
        "form": "tablet",
        "strength": "500 mg",
        "dose": "1 tablet",
        "code": "SOS",
        "per_day": None,
        "timings": [],
        "food": None,
        "food_text": "(if fever)",
        "days": None,
        "days_text": "",
    },
    {
        "name": "Shelcal 500",
        "form": "tablet",
        "strength": None,
        "dose": "1 tablet",
        "code": "0-0-1",
        "per_day": 1,
        "timings": ["night"],
        "food": "after",
        "food_text": "after food",
        "days": 30,
        "days_text": "x 30 days",
    },
    {
        "name": "Metformin",
        "form": "tablet",
        "strength": "500 mg",
        "dose": "1 tablet",
        "code": "1-0-1",
        "per_day": 2,
        "timings": ["morning", "night"],
        "food": "after",
        "food_text": "PC",
        "days": None,
        "days_text": "continue",
    },
    {
        "name": "Omez",
        "form": "capsule",
        "strength": "20 mg",
        "dose": "1 capsule",
        "code": "1-0-0",
        "per_day": 1,
        "timings": ["morning"],
        "food": "before",
        "food_text": "khali pet",
        "days": 14,
        "days_text": "x 2 weeks",
    },
    {
        "name": "Telma 40",
        "form": "tablet",
        "strength": None,
        "dose": "1/2 tablet",
        "code": "OD",
        "per_day": 1,
        "timings": [],
        "food": None,
        "food_text": "",
        "days": None,
        "days_text": "continue",
    },
    {
        "name": "Allegra 120",
        "form": "tablet",
        "strength": None,
        "dose": "1 tablet",
        "code": "twice daily",
        "per_day": 2,
        "timings": [],
        "food": "after",
        "food_text": "after food",
        "days": 5,
        "days_text": "for 5 days",
    },
    {
        "name": "Becosules",
        "form": "capsule",
        "strength": None,
        "dose": "1 capsule",
        "code": "1-1-1",
        "per_day": 3,
        "timings": ["morning", "afternoon", "night"],
        "food": "after",
        "food_text": "PC",
        "days": 10,
        "days_text": "x 10 days",
    },
    {
        "name": "Volini",
        "form": "cream",
        "strength": None,
        "dose": None,
        "code": "SOS",
        "per_day": None,
        "timings": [],
        "food": None,
        "food_text": "local application",
        "days": None,
        "days_text": "",
    },
]


def field(value: Any, confidence: float = 0.95) -> dict[str, Any]:
    return {"value": value, "confidence": confidence if value is not None else 0.1}


def gold_medicine(spec: dict[str, Any], *, unreadable: bool) -> dict[str, Any]:
    """The gold `Medicine`. An unreadable (scribbled) line has no readable name."""
    is_sos = spec["code"] == "SOS"
    line = f"{PREFIX[spec['form']]} {spec['name']} {spec['code']}"
    return {
        "raw_text": field(None if unreadable else line),
        "name": field(None if unreadable else spec["name"]),
        "form": field(spec["form"], 0.9),
        "strength": field(spec["strength"], 0.85),
        "dose": field(spec["dose"], 0.9),
        "frequency_code": field(spec["code"], 0.9),
        "frequency_per_day": field(spec["per_day"], 0.9),
        "timings": field(spec["timings"] or None, 0.85),
        "relation_to_food": field(spec["food"], 0.85),
        "duration_days": field(spec["days"], 0.9),
        "as_needed": is_sos,
        "instructions": field(None, 0.0),
    }


def load_font(size: int) -> tuple[ImageFont.FreeTypeFont | ImageFont.ImageFont, str]:
    candidates = [*sorted(FONT_DIR.glob("*.ttf")), *(Path(p) for p in SYSTEM_FONTS)]
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size), path.name
    return ImageFont.load_default(size=size), "pillow-default"


def draw_scribble(
    draw: ImageDraw.ImageDraw, x: int, y: int, width: int, rng: random.Random
) -> None:
    """An illegible blob where a medicine name used to be."""
    points = [(x, y + 20)]
    for step in range(0, width, 9):
        points.append((x + step, y + 8 + rng.randint(0, 34)))
    draw.line(points, fill=(20, 20, 60), width=4)
    draw.line([(x, y + 38), (x + width, y + 10)], fill=(20, 20, 60), width=3)


def render(case: dict[str, Any], rng: random.Random) -> tuple[Image.Image, str]:
    layout = case["layout"]
    width, height = (1240, 1754) if layout != 2 else (1240, 1500)
    paper = (rng.randint(240, 252), rng.randint(238, 250), rng.randint(228, 246))
    page = Image.new("RGB", (width, height), paper)
    draw = ImageDraw.Draw(page)
    body, font_name = load_font(44)
    small, _ = load_font(30)
    ink = (rng.randint(10, 40), rng.randint(10, 40), rng.randint(40, 110))

    # Header: fictional clinic, doctor, patient, phone (none of this is in the gold extraction).
    draw.text((60, 50), case["phi"]["clinic"], fill=(30, 60, 30), font=body)
    draw.text(
        (60, 110),
        f"{case['phi']['doctor']}   Reg. No. {rng.randint(10000, 99999)}",
        fill=(30, 30, 30),
        font=small,
    )
    draw.text((60, 160), f"Ph: {case['phi']['phone']}", fill=(30, 30, 30), font=small)
    draw.line([(50, 210), (width - 50, 210)], fill=(90, 90, 90), width=2)
    draw.text(
        (60, 240),
        f"Name: {case['phi']['patient']}    Age: {rng.randint(8, 80)}",
        fill=ink,
        font=small,
    )
    draw.text(
        (width - 360, 240),
        f"Date: {rng.randint(1, 28)}/{rng.randint(1, 12)}/2026",
        fill=ink,
        font=small,
    )
    draw.text((60, 330), "Rx", fill=ink, font=load_font(70)[0])

    y = 430
    for number, entry in enumerate(case["lines"], start=1):
        spec = entry["spec"]
        prefix = PREFIX[spec["form"]]
        x = 100
        if layout == 1:
            x += rng.randint(-10, 25)  # uneven handwriting baseline
        label = f"{number}. "
        draw.text((x - 55, y), label, fill=ink, font=body)
        if entry["unreadable"]:
            draw_scribble(draw, x, y, 330, rng)
            rest = f"   {spec['code']}   {spec['food_text']}   {spec['days_text']}".rstrip()
            draw.text((x + 360, y), rest, fill=ink, font=body)
        else:
            strength = f" {spec['strength']}" if spec["strength"] else ""
            # A 1-0-1 style pattern implies "one unit at each marked time"; every other way of
            # writing the frequency needs the dose written next to it (like real prescriptions).
            implicit = re.fullmatch(r"\d(-\d){2,3}", spec["code"]) is not None
            dose = ""
            if spec["dose"] and (not implicit or spec["form"] == "syrup"):
                dose = spec["dose"].replace("tablet", "tab").replace("capsule", "cap")
            parts = [
                f"{prefix} {spec['name']}{strength}",
                dose,
                spec["code"],
                spec["food_text"],
                spec["days_text"],
            ]
            draw.text((x, y), "   ".join(p for p in parts if p), fill=ink, font=body)
        if entry.get("crossed_out"):
            draw.line([(x - 10, y + 28), (width - 120, y + 28)], fill=(40, 40, 40), width=5)
        y += 120
        if layout == 2:
            draw.line([(x - 55, y - 28), (width - 60, y - 28)], fill=(200, 200, 200), width=1)

    draw.text((width - 460, height - 150), "(signature)", fill=ink, font=small)

    # Photo-like degradation.
    page = page.rotate(
        case["rotation"], resample=Image.Resampling.BICUBIC, fillcolor=(235, 235, 235), expand=True
    )
    if case["blur"] > 0:
        page = page.filter(ImageFilter.GaussianBlur(case["blur"]))
    noise = Image.effect_noise(page.size, case["noise"]).convert("RGB")
    page = Image.blend(page, noise, 0.04)
    return page, font_name


def build_case(index: int) -> dict[str, Any]:
    rng = random.Random(1000 + index)
    count = rng.randint(2, 5)
    chosen = rng.sample(SPECS, count)
    has_unreadable = index % 4 == 0
    unreadable_at = rng.randrange(count) if has_unreadable else None
    lines = [
        {"spec": spec, "unreadable": position == unreadable_at}
        for position, spec in enumerate(chosen)
    ]
    # A struck-through decoy line: a medicine that must NOT be extracted.
    decoy: dict[str, Any] | None = None
    if index % 5 == 0:
        remaining = [s for s in SPECS if s not in chosen]
        decoy = rng.choice(remaining)
        lines.append({"spec": decoy, "unreadable": False, "crossed_out": True})
    return {
        "id": f"rx_{index:03d}",
        "layout": index % 3,
        "rotation": rng.uniform(-3.0, 3.0),
        "blur": rng.choice([0, 0, 0.6, 1.0]),
        "noise": rng.choice([20, 40, 60]),
        "phi": {
            "patient": rng.choice(PATIENTS),
            "doctor": rng.choice(DOCTORS),
            "clinic": rng.choice(CLINICS),
            "phone": f"9{rng.randint(100000000, 999999999)}",
        },
        "lines": lines,
        "unreadable_at": unreadable_at,
        "decoy": decoy["name"] if decoy else None,
    }


def label_for(case: dict[str, Any]) -> dict[str, Any]:
    medicines = [
        gold_medicine(entry["spec"], unreadable=entry["unreadable"])
        for entry in case["lines"]
        if not entry.get("crossed_out")
    ]
    unreadable = [i for i, entry in enumerate(case["lines"]) if entry["unreadable"]]
    return {
        "id": case["id"],
        "layout": case["layout"],
        "gold": {
            "kind": "prescription",
            "is_prescription": True,
            "image_quality": "good",
            "medicines": medicines,
            "prescription_date": {"value": None, "confidence": 0.0},
            "overall_confidence": 0.9,
            "notes_for_user": [],
        },
        "unreadable_indexes": unreadable,
        "decoy_name": case["decoy"],
        "phi_strings": [
            case["phi"]["patient"],
            case["phi"]["doctor"].replace("Dr. ", ""),
            case["phi"]["phone"],
            case["phi"]["clinic"],
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--count", type=int, default=24)
    args = parser.parse_args()

    (OUT / "images").mkdir(parents=True, exist_ok=True)
    (OUT / "labels").mkdir(parents=True, exist_ok=True)
    font_name = ""
    for index in range(args.count):
        case = build_case(index)
        rng = random.Random(5000 + index)
        page, font_name = render(case, rng)
        page.convert("RGB").save(OUT / "images" / f"{case['id']}.jpg", quality=88)
        (OUT / "labels" / f"{case['id']}.json").write_text(
            json.dumps(label_for(case), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    print(f"wrote {args.count} synthetic prescriptions to {OUT} (font: {font_name})")


if __name__ == "__main__":
    main()
