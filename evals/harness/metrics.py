"""Shared metric helpers (accuracy, precision/recall/F1, WER, percentiles, dataset hash)."""

import hashlib
import re
from collections.abc import Iterable
from pathlib import Path


def ratio(ok: int, total: int, empty: float = 1.0) -> float:
    """ok/total; an empty denominator counts as `empty` (1.0: nothing to get wrong)."""
    return empty if total == 0 else ok / total


def prf(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    precision = ratio(tp, tp + fp)
    recall = ratio(tp, tp + fn)
    f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return precision, recall, f1


def percentile(values: Iterable[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]


def edit_distance(a: list[str], b: list[str]) -> int:
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1]


def wer(reference: str, hypothesis: str) -> float:
    ref = re.findall(r"\w+", reference.casefold())
    hyp = re.findall(r"\w+", hypothesis.casefold())
    return edit_distance(ref, hyp) / max(len(ref), 1)


def dataset_hash(path: Path | None) -> str:
    """Short hash of the COMMITTED dataset files (labels, jsonl, manifests). Generated images are
    skipped on purpose: they are rebuilt from the generator script, whose source is hashed instead."""
    if path is None or not path.exists():
        return "none"
    skip = {".jpg", ".jpeg", ".png", ".webp", ".pdf", ".ogg", ".opus", ".wav", ".pyc"}
    files = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
    digest = hashlib.sha256()
    for file in files:
        if file.suffix.lower() in skip or "__pycache__" in file.parts:
            continue
        digest.update(file.name.encode())
        digest.update(file.read_bytes())
    return digest.hexdigest()[:12]
