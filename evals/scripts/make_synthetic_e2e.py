"""Renders the two lab-report pages used by the end-to-end conversation scenarios.

The AI service in `LLM_MODE=fake` never reads pixels. To let a conversation test send a LAB REPORT (and not
only prescriptions) over HTTP, these pages carry a solid blue square in the top-left corner: the fake model
recognises it (`app/llm/fake.py: image_kind_hint`) as "this is a lab report". Prescription fixtures need no
marker. Pages are synthetic (fake lab name, no patient data); the images are gitignored.

Run: python evals/scripts/make_synthetic_e2e.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "evals" / "datasets" / "e2e" / "images"
MARKER = (20, 60, 200)
PAGES = {
    "lab_a": [
        "Synthetic Lab Pvt Ltd",
        "Haemoglobin   13.2 g/dL   (13.0 - 17.0)",
        "Total Leucocyte Count   7200 /cumm   (4000 - 11000)",
    ],
    "lab_b": [
        "Synthetic Lab Pvt Ltd",
        "Haemoglobin   12.8 g/dL   (13.0 - 17.0)",
        "Fasting Glucose   104 mg/dL   (70 - 100)",
    ],
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default(size=34)
    for name, lines in PAGES.items():
        page = Image.new("RGB", (1200, 1600), (250, 250, 245))
        draw = ImageDraw.Draw(page)
        draw.rectangle((0, 0, 32, 32), fill=MARKER)
        y = 120
        for line in lines:
            draw.text((60, y), line, fill=(15, 15, 40), font=font)
            y += 90
        page.save(OUT / f"{name}.jpg", quality=95, subsampling=0)
    print(f"{len(PAGES)} e2e lab pages -> {OUT}")


if __name__ == "__main__":
    main()
