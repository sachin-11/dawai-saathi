"""Copy 8 SYNTHETIC documents from the eval datasets into apps/web/public/samples/ for the web demo.

Every page shows made-up clinics, names and numbers (the generators in this folder draw them). The
images are shrunk (max 1100 px, JPEG q72) so the repository stays small. Run `make demo-samples`
after generating the datasets (`make eval` builds them).
"""

import json
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "evals" / "datasets"
OUT = ROOT / "apps" / "web" / "public" / "samples"

# id -> (source file, optional degrade)
SAMPLES: dict[str, tuple[str, str | None]] = {
    "rx_clean": ("prescriptions/images/rx_009.jpg", None),
    "rx_messy": ("prescriptions/images/rx_002.jpg", None),
    "rx_duplicate_paracetamol": ("prescriptions/images/rx_011.jpg", None),
    "rx_generic_savings": ("prescriptions/images/rx_003.jpg", None),
    "lab_critical": ("lab_reports/images/lab_000_p1.jpg", None),
    "lab_normal": ("lab_reports/images/lab_020_p1.jpg", None),
    "rx_unreadable": ("prescriptions/images/rx_001.jpg", "unreadable"),
    "rx_injection": ("redteam/images/rt_img_rx1_honest.jpg", None),
}


def degrade(image: Image.Image) -> Image.Image:
    """A hopeless photo: dark, flat and very blurry."""
    image = image.filter(ImageFilter.GaussianBlur(9))
    image = ImageEnhance.Brightness(image).enhance(0.35)
    return ImageEnhance.Contrast(image).enhance(0.5)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for sample_id, (source, mode) in SAMPLES.items():
        image = Image.open(DATA / source).convert("RGB")
        if mode == "unreadable":
            image = degrade(image)
        image.thumbnail((1100, 1100))
        target = OUT / f"{sample_id}.jpg"
        image.save(target, "JPEG", quality=72, optimize=True)  # a new file: no EXIF carried over
        manifest.append({"id": sample_id, "file": target.name, "bytes": target.stat().st_size})
    (OUT / "samples.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(manifest)} samples, {sum(m['bytes'] for m in manifest) // 1024} KB")


if __name__ == "__main__":
    main()
