"""Load the curated interaction core list (M11): expand classes, canonicalise salts, order and dedupe.

Pure functions, no I/O beyond reading the CSV files: `seed_interactions.py` writes the report and the
database, the tests import this module directly (same pattern as `catalog_sources.py`).

Rules:
  * a salt name goes through the SAME normaliser as the catalog (`app.catalog.normalise`), so a pair
    row and a medicine's `salt_key` components are spelled identically
  * a pair is stored once, `salt_a < salt_b`; when two source rows disagree the HIGHER severity wins
    and both are written to `source_ref`
  * a row with an unknown effect code, severity, or an unparseable salt is rejected and counted
  * the Hindi management text is a safe generic line until a human reviewed it (`hi_reviewed`)
"""

import csv
import sys
from collections import Counter
from dataclasses import dataclass, field, replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))

from app.catalog.normalise import normalise_salt  # noqa: E402
from app.interactions.effects import EFFECTS  # noqa: E402
from app.interactions.render import GENERIC_EN, GENERIC_HI  # noqa: E402

SOURCE_NAME = "Dawai Saathi curated list from drug labels (pharmacist review pending)"
SOURCE_VERSION = "core-v1"
SEVERITIES = ("minor", "moderate", "major")
_RANK = {name: index for index, name in enumerate(SEVERITIES)}

MANAGEMENT_EN = {
    "major": "This combination is known to be important. Please talk to your doctor or pharmacist before taking these together.",
    "moderate": "Some caution is needed. Please ask your doctor or pharmacist before taking these together.",
    "minor": "This is usually a minor note. You may mention it to your doctor or pharmacist.",
}


@dataclass(frozen=True, slots=True)
class InteractionRecord:
    salt_a: str
    salt_b: str
    severity: str
    effect_code: str
    mechanism: str
    summary: str
    management_en: str
    management_hi: str
    hi_reviewed: bool
    evidence_level: str
    source: str
    source_ref: str
    source_version: str


@dataclass(slots=True)
class LoadResult:
    rows_read: int = 0
    pairs_expanded: int = 0
    records: list[InteractionRecord] = field(default_factory=list)
    rejected: Counter[str] = field(default_factory=Counter)
    examples: dict[str, list[str]] = field(default_factory=dict)
    conflicts: list[str] = field(default_factory=list)
    unknown_to_catalog: set[str] = field(default_factory=set)

    def reject(self, reason: str, example: str) -> None:
        self.rejected[reason] += 1
        shown = self.examples.setdefault(reason, [])
        if len(shown) < 3:
            shown.append(example)


def load_classes(path: Path) -> tuple[dict[str, list[str]], list[str]]:
    """`class,salt` rows -> {class: [canonical salt, ...]} and the names that could not be parsed."""
    classes: dict[str, list[str]] = {}
    bad: list[str] = []
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            salt = normalise_salt(row["salt"])
            if not salt:
                bad.append(row["salt"])
                continue
            members = classes.setdefault(row["class"].strip(), [])
            if salt not in members:
                members.append(salt)
    return classes, bad


def _expand(token: str, classes: dict[str, list[str]]) -> list[str] | None:
    token = token.strip()
    if token.startswith("@"):
        return classes.get(token[1:])
    salt = normalise_salt(token)
    return [salt] if salt else None


def load_interactions(
    core_csv: Path,
    classes_csv: Path,
    *,
    catalog_salts: set[str] | None = None,
    reviewed_hi: dict[tuple[str, str], str] | None = None,
) -> LoadResult:
    """Read the core list. `catalog_salts` (salts of the loaded catalog) only drives the report of
    pairs that can never fire because no catalog product contains that salt."""
    classes, bad_class_names = load_classes(classes_csv)
    result = LoadResult()
    for name in bad_class_names:
        result.reject("class_salt_unparseable", name)

    merged: dict[tuple[str, str], InteractionRecord] = {}
    with core_csv.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            result.rows_read += 1
            label = f"{row.get('salt_a')} x {row.get('salt_b')}"
            severity = (row.get("severity") or "").strip()
            effect = (row.get("effect_code") or "").strip()
            if severity not in SEVERITIES:
                result.reject("bad_severity", label)
                continue
            if effect not in EFFECTS:
                result.reject("unknown_effect_code", f"{label} ({effect})")
                continue
            side_a = _expand(row["salt_a"], classes)
            side_b = _expand(row["salt_b"], classes)
            if not side_a or not side_b:
                result.reject("unmapped_salt_or_class", label)
                continue
            if not (row.get("source_ref") or "").strip():
                result.reject("no_citation", label)
                continue
            for a in side_a:
                for b in side_b:
                    if a == b:
                        continue  # a salt is not an "interaction" with itself (that is a duplicate)
                    result.pairs_expanded += 1
                    salt_a, salt_b = (a, b) if a < b else (b, a)
                    record = _record(row, salt_a, salt_b, severity, effect, reviewed_hi)
                    key = (salt_a, salt_b)
                    existing = merged.get(key)
                    if existing is None:
                        merged[key] = record
                        continue
                    if existing.severity != record.severity:
                        result.conflicts.append(
                            f"{salt_a} x {salt_b}: {existing.severity} vs {record.severity}"
                        )
                    winner = record if _RANK[record.severity] > _RANK[existing.severity] else existing
                    other = existing if winner is record else record
                    refs = winner.source_ref
                    if other.source_ref not in refs:
                        refs = f"{refs} | also: {other.source_ref}"
                    merged[key] = replace(winner, source_ref=refs)
    result.records = sorted(merged.values(), key=lambda r: (r.salt_a, r.salt_b))
    if catalog_salts is not None:
        for record in result.records:
            for salt in (record.salt_a, record.salt_b):
                if salt not in catalog_salts:
                    result.unknown_to_catalog.add(salt)
    return result


def _record(
    row: dict[str, str],
    salt_a: str,
    salt_b: str,
    severity: str,
    effect: str,
    reviewed_hi: dict[tuple[str, str], str] | None,
) -> InteractionRecord:
    reviewed = (reviewed_hi or {}).get((salt_a, salt_b))
    effect_en = EFFECTS[effect][0]
    return InteractionRecord(
        salt_a=salt_a,
        salt_b=salt_b,
        severity=severity,
        effect_code=effect,
        mechanism=(row.get("mechanism") or "").strip(),
        summary=f"Taking these together {effect_en}.",
        management_en=MANAGEMENT_EN.get(severity, GENERIC_EN),
        management_hi=reviewed or GENERIC_HI,
        hi_reviewed=reviewed is not None,
        evidence_level=(row.get("evidence_level") or "").strip(),
        source=SOURCE_NAME,
        source_ref=(row.get("source_ref") or "").strip(),
        source_version=SOURCE_VERSION,
    )


def load_reviewed_hi(path: Path) -> dict[tuple[str, str], str]:
    """`salt_a,salt_b,management_hi` rows a human reviewed and approved. Missing file = none yet."""
    if not path.exists():
        return {}
    reviewed: dict[tuple[str, str], str] = {}
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            text = (row.get("management_hi") or "").strip()
            a, b = row["salt_a"].strip(), row["salt_b"].strip()
            if text:
                reviewed[(a, b) if a < b else (b, a)] = text
    return reviewed


def catalog_salts_from(records: list[object]) -> set[str]:
    """Salts of the loaded catalog (the components of every `salt_key`)."""
    salts: set[str] = set()
    for record in records:
        key = getattr(record, "salt_key", None)
        if key:
            salts.update(part for part in key.split("+") if part)
    return salts
