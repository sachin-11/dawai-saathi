"""The interaction checker (M11, CLAUDE.md §1 F6, §2.5). Deterministic: no model, no network.

Two kinds of finding:
  duplicate_ingredient   the same salt in two DIFFERENT medicines (two brands of paracetamol from two
                         doctors). A real overdose risk in India. No dose advice, ever.
  interaction            a pair of salts from two different medicines that has a row in `interactions`.

Rules that matter:
  * a combination product is split into its salts ("amlodipine+telmisartan"); two salts of the SAME
    medicine are never compared with each other
  * no claim without a database row: the model has no say here; a pair without a row is "not found",
    which is NOT "safe" (see the wording in `app/interactions/render.py`)
  * a medicine whose salt is not certain is NOT checked and is reported as such, never as safe
  * the database failing is reported (`database_ok=False`), never turned into "no interaction"
"""

from collections.abc import Sequence
from dataclasses import dataclass
from itertools import combinations
from typing import cast

import structlog

from app.catalog.normalise import brand_key
from app.interactions.repository import InteractionRepository, InteractionRow, ordered
from app.schemas.catalog import DrugMatch, MatchMethod
from app.schemas.interactions import (
    InteractionFinding,
    InteractionReport,
    ManagementKey,
    Severity,
    UncheckedMedicine,
)

log = structlog.get_logger("interaction_check")

NEW_REF_PREFIX = "rx:"

# Same-salt duplicates of these carry a real overdose risk: they get their own, firmer wording.
OVERDOSE_RISK_SALTS = frozenset(
    {
        "paracetamol",
        "ibuprofen",
        "diclofenac",
        "naproxen",
        "aceclofenac",
        "nimesulide",
        "ketorolac",
        "etoricoxib",
        "piroxicam",
        "mefenamic acid",
        "indomethacin",
        "celecoxib",
        "aspirin",
    }
)

_SEVERITY_RANK: dict[str, int] = {"major": 0, "moderate": 2, "minor": 3}
# A duplicate ingredient ranks between a major pair and a moderate pair.
_DUPLICATE_RANK = 1


@dataclass(frozen=True, slots=True)
class CheckedMedication:
    ref: str  # "rx:<index>" for a new medicine, otherwise the stored medication's id
    label: str | None
    salt_key: str | None  # None = the salt is not certain: not checked
    is_new: bool = True


# An interaction belongs to the ACTIVE MOIETY, not to its salt form: the catalog keeps "warfarin
# sodium" apart from "warfarin" (it must, for a generic swap), the interaction table does not.
MOIETY: dict[str, str] = {
    "warfarin sodium": "warfarin",
    "diclofenac sodium": "diclofenac",
    "diclofenac potassium": "diclofenac",
    "levothyroxine sodium": "levothyroxine",
    "losartan potassium": "losartan",
    "metoprolol succinate": "metoprolol",
    "metoprolol tartrate": "metoprolol",
    "phenytoin sodium": "phenytoin",
    "valproate sodium": "valproic acid",
    "sodium valproate": "valproic acid",
    "valproate": "valproic acid",
    "ferrous sulphate": "ferrous sulfate",
    "naproxen sodium": "naproxen",
    "ketorolac tromethamine": "ketorolac",
    "ketorolac trometamol": "ketorolac",
    "mefenamic": "mefenamic acid",
    "aluminium hydroxide gel": "aluminium hydroxide",
    "magnesium hydroxide suspension": "magnesium hydroxide",
    "potassium chloride": "potassium chloride",
    "clopidogrel bisulfate": "clopidogrel",
    "clopidogrel bisulphate": "clopidogrel",
    "atorvastatin calcium": "atorvastatin",
    "rosuvastatin calcium": "rosuvastatin",
}


def components(salt_key: str) -> list[str]:
    """`amlodipine+telmisartan` -> ['amlodipine', 'telmisartan'] (deduplicated, in order, active
    moiety names)."""
    seen: list[str] = []
    for part in salt_key.split("+"):
        salt = MOIETY.get(part.strip(), part.strip())
        if salt and salt not in seen:
            seen.append(salt)
    return seen


def salt_is_certain(match: DrugMatch | None, match_min: float, name: str | None = None) -> bool:
    """A salt is used for a check only when it was written, matched with a confident score, or the
    typed name is the start of the matched brand ("Dolo" -> "Dolo 650": a brand family, not a guess).

    A strength, form or release conflict does not change the SALT, so it does not block the check (an
    interaction is a property of the ingredient); an ambiguous match only keeps a salt key when all
    candidates share it (see the matcher), so `salt_key` being present is enough in that case. A weak
    fuzzy match that is NOT a prefix of the brand ("Dollo" -> "Dolo") is never used."""
    if match is None or not match.salt_key:
        return False
    if match.method is MatchMethod.none:
        return False
    if match.method is MatchMethod.salt_written or match.score >= match_min:
        return True
    if match.method is MatchMethod.trgm and name and match.score >= 0.5:
        # an ambiguous match has no single brand: every candidate must carry the typed name
        names = [match.brand_name] if match.brand_name else [c.brand_name for c in match.candidates]
        typed = brand_key(name)
        return (
            len(typed) >= 4 and bool(names) and all(brand_key(n).startswith(typed) for n in names)
        )
    return False


def _finding_sort_key(finding: InteractionFinding) -> tuple[int, str, str]:
    if finding.type == "duplicate_ingredient":
        rank = _DUPLICATE_RANK
    else:
        rank = _SEVERITY_RANK[finding.severity or "moderate"]
    return (rank, finding.salt_a, finding.salt_b)


def sort_findings(findings: Sequence[InteractionFinding]) -> list[InteractionFinding]:
    """major, then duplicates, then moderate, then minor; ties by salt name (stable and testable)."""
    return sorted(findings, key=_finding_sort_key)


def _wording_key(severity: str | None, duplicate_salt: str | None) -> ManagementKey:
    if duplicate_salt is not None:
        return "duplicate_overdose" if duplicate_salt in OVERDOSE_RISK_SALTS else "duplicate"
    return cast(
        ManagementKey, severity if severity in ("major", "moderate", "minor") else "moderate"
    )


def finding_from_row(
    row: InteractionRow, *, refs: list[str], labels: list[str], involves_new: bool
) -> InteractionFinding:
    """A finding is a database row plus the medicines it applies to: all its words come from the row."""
    severity = cast(Severity, row.severity)
    return InteractionFinding(
        type="interaction",
        severity=severity,
        salt_a=row.salt_a,
        salt_b=row.salt_b,
        medication_refs=refs,
        labels=labels,
        interaction_id=row.id,
        effect_code=row.effect_code or None,
        management_key=_wording_key(severity, None),
        involves_new=involves_new,
        management_en=row.management_en or None,
        management_hi=row.management_hi or None,
        hi_reviewed=row.hi_reviewed,
        source_name=row.source or None,
    )


def duplicate_finding(
    salt: str, *, refs: list[str], labels: list[str], involves_new: bool
) -> InteractionFinding:
    return InteractionFinding(
        type="duplicate_ingredient",
        salt_a=salt,
        salt_b=salt,
        medication_refs=refs,
        labels=labels,
        management_key=_wording_key(None, salt),
        involves_new=involves_new,
    )


async def check_interactions(
    medications: Sequence[CheckedMedication],
    repo: InteractionRepository,
    *,
    only_new: bool = True,
) -> InteractionReport:
    """Check every medicine against every other one.

    `only_new=True` (a new prescription or a typed question): only findings that involve at least one
    new medicine are returned, so an old warning is not announced again. `only_new=False` (the CHECK
    command, where every stored medicine is "new"): all findings.
    """
    unchecked = [UncheckedMedicine(ref=m.ref, label=m.label) for m in medications if not m.salt_key]
    checkable = [m for m in medications if m.salt_key]
    by_salt: dict[str, list[CheckedMedication]] = {}
    for medicine in checkable:
        assert medicine.salt_key  # noqa: S101 - filtered above
        for salt in components(medicine.salt_key):
            by_salt.setdefault(salt, []).append(medicine)

    findings: dict[tuple[str, str, str], InteractionFinding] = {}

    # ---- duplicate ingredient: one salt, two or more DIFFERENT medicines
    for salt, holders in sorted(by_salt.items()):
        distinct = list({h.ref: h for h in holders}.values())
        if len(distinct) < 2:
            continue
        involves_new = any(h.is_new for h in distinct)
        if only_new and not involves_new:
            continue
        findings[("duplicate_ingredient", salt, salt)] = duplicate_finding(
            salt,
            refs=[h.ref for h in distinct],
            labels=[h.label or "" for h in distinct],
            involves_new=involves_new,
        )

    # ---- pairs of different salts that belong to different medicines
    candidate_pairs: dict[tuple[str, str], set[str]] = {}
    for salt_x, salt_y in combinations(sorted(by_salt), 2):
        refs: set[str] = set()
        for a in by_salt[salt_x]:
            for b in by_salt[salt_y]:
                if a.ref != b.ref:  # two salts of ONE combination product are never compared
                    refs.update((a.ref, b.ref))
        if refs:
            candidate_pairs[ordered(salt_x, salt_y)] = refs

    rows: list[InteractionRow] = []
    database_ok = True
    try:
        rows = await repo.pairs(candidate_pairs)
    except Exception as error:  # DB down: say so, do not turn it into "no interaction found"
        database_ok = False
        log.warning("interaction_lookup_failed", error_type=type(error).__name__)

    by_ref = {m.ref: m for m in checkable}
    order = {m.ref: index for index, m in enumerate(checkable)}
    for row in rows:
        refs_sorted = sorted(candidate_pairs[(row.salt_a, row.salt_b)], key=order.__getitem__)
        involved = [by_ref[r] for r in refs_sorted]
        involves_new = any(m.is_new for m in involved)
        if only_new and not involves_new:
            continue
        findings[("interaction", row.salt_a, row.salt_b)] = finding_from_row(
            row,
            refs=refs_sorted,
            labels=[m.label or "" for m in involved],
            involves_new=involves_new,
        )

    return InteractionReport(
        findings=sort_findings(list(findings.values())),
        unchecked=unchecked,
        checked_count=len(checkable),
        database_ok=database_ok,
    )
