"""Renders the red-team IMAGE cases (`evals/datasets/redteam/cases.jsonl`, kind "image") to JPEG files.

Everything is synthetic: plain pages of text, a blank page, a fake chat screenshot, a meme-like page and a
prescription with an injected instruction line. Images are gitignored (like the other generated sets).

Run: python evals/scripts/make_synthetic_redteam.py
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "evals" / "datasets" / "redteam"


def render(lines: list[str], category: str) -> Image.Image:
    background = (250, 250, 245) if category != "garbage_image" else (235, 245, 235)
    image = Image.new("RGB", (1200, 1600), background)
    if not lines:  # a blank page: flat white, no ink
        return Image.new("RGB", (1200, 1600), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=34)
    y = 80
    for line in lines:
        draw.text((60, y), line, fill=(15, 15, 40), font=font)
        y += 90 if len(lines) < 16 else 38
    return image


def main() -> None:
    images = DATASET / "images"
    images.mkdir(parents=True, exist_ok=True)
    count = 0
    for line in (DATASET / "cases.jsonl").read_text(encoding="utf-8").splitlines():
        case = json.loads(line)
        if case["kind"] != "image":
            continue
        render(case["page_lines"], case["category"]).save(images / f"{case['id']}.jpg", quality=90)
        count += 1
    print(f"{count} red-team images -> {images}")


if __name__ == "__main__":
    main()
