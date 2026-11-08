"""Match a prescribed medicine to the catalog (M8). Deterministic code: the LLM never picks a salt.

Order (first stage that finds something wins):
  1. exact         normalised brand name ("Tab. Dolo-650" -> dolo650), also name + written strength
  2. salt_written  the prescription wrote the generic name ("Metformin 500 mg"): salt + strength lookup
  3. trgm          pg_trgm similarity on the brand key, boosted when the strength agrees
  4. vector        `VectorStore` fallback (only when 1-3 found nothing)
  5. none          no confident match: the medicine is shown from the prescription alone

Deviation from the written order: the salt stage runs BEFORE trigram. A generic name such as
"paracetamol" must not be fuzzy-matched to some brand with a similar spelling.

What the prescription writes always wins over the catalog (CLAUDE.md M8 §4): a different strength or
a clearly different form is recorded as a conflict and the generic finder then refuses, with the
reason. A match whose strength cannot be confirmed (no written strength, and no number in the brand
name that equals a catalog strength) is never used for a generic either.
"""

import re
from dataclasses import dataclass
from decimal import Decimal

from app.catalog.normalise import (
    brand_key,
    build_keys,
    explicit_form,
    find_strengths,
    parse_form,
    parse_release,
    parse_strength,
    split_salts,
    total_amount,
)
from app.catalog.repository import CatalogRepository, DrugRow
from app.catalog.vector import VectorStore, query_text
from app.schemas.catalog import DrugCandidate, DrugMatch, MatchMethod

TIE_WINDOW = 0.05
STRENGTH_BOOST = 0.1
SALT_WRITTEN_SCORE = 0.9
VECTOR_SCORE_CAP = 0.95
PREFIX_MIN_LEN = 4
PREFIX_BASE, PREFIX_SPAN = 0.5, 0.3  # a prefix hit scores 0.5-0.8: never enough for a generic alone


@dataclass(frozen=True, slots=True)
class MatcherConfig:
    trgm_min: float = 0.45
    match_min: float = 0.8
    vector_min: float = 0.8


_FORM_WORDS = re.compile(
    r"\b(?:tab|tablets?|caps?|capsules?|syp|syrup|inj|injection|drops?|cream|gel|ointment|inhaler|"
    r"suspension|susp|oral|sr|er|xr|cr|mr|dr)\b\.?",
    re.IGNORECASE,
)
_COMPATIBLE_FORMS = {frozenset({"syrup", "suspension"})}


def _form_conflict(rx_form: str | None, row_form: str) -> bool:
    """Does the written form contradict the product's? `other` is an explicitly non-substitutable form
    (eye drops, chewable ...): it conflicts with any product that is not itself `other`."""
    if rx_form is None or rx_form == "powder":
        return False
    if rx_form == row_form:
        return False
    return frozenset({rx_form, row_form}) not in _COMPATIBLE_FORMS


def _written_form(name: str, form_field: str | None) -> str | None:
    """The form the prescription or the typed question states. The `form` FIELD (the model's reading of
    a prescription) says "other" for "unknown" and is then ignored; a form WORD in the name itself
    ("Dolo 650 syrup", "... eye drops") is taken at its word, so a syrup question never gets a tablet
    generic."""
    field = parse_form(form_field)[0] if form_field else None
    if field is not None and field != "other":
        return field
    return explicit_form(name)


def _strength_relation(rx_key: str | None, row_key: str) -> tuple[bool, bool]:
    """(verified, conflict). A combination's written total ("625 mg") equals the sum of its parts."""
    if rx_key is None:
        return False, False
    if rx_key == row_key or rx_key == total_amount(row_key):
        return True, False
    return False, True


def _digits_in(name: str) -> list[str]:
    return re.findall(r"\d+(?:\.\d+)?", name)


def _brand_number_confirms(query_name: str, row: DrugRow) -> bool:
    """ "Dolo 650": a number in the written name equals an amount in the catalog strength."""
    amounts: set[Decimal] = set()
    for part in [*row.strength_key.split("+"), total_amount(row.strength_key) or ""]:
        parsed = parse_strength(part)
        if parsed is not None and parsed.per_unit is None:
            amounts.add(parsed.amount)
    return any(Decimal(number) in amounts for number in _digits_in(query_name))


def _candidates(scored: list[tuple[DrugRow, float]]) -> list[DrugCandidate]:
    seen: set[str] = set()
    out: list[DrugCandidate] = []
    for row, score in scored:
        if row.id in seen:
            continue
        seen.add(row.id)
        out.append(
            DrugCandidate(
                drug_id=row.id, brand_name=row.brand_name[:200], score=round(min(score, 1.0), 3)
            )
        )
        if len(out) == 3:
            break
    return out


def _finish(
    scored: list[tuple[DrugRow, float]],
    *,
    method: MatchMethod,
    rx_key: str | None,
    rx_form: str | None,
    query_name: str,
    allow_brand_number: bool,
    rx_modified: bool | None = None,
) -> DrugMatch:
    """Pick the product among scored rows (best first), detect ambiguity and strength/form conflicts."""
    if rx_key is not None:  # a written strength decides between products of the same brand family
        agreeing = [(r, s) for r, s in scored if _strength_relation(rx_key, r.strength_key)[0]]
        if agreeing:
            scored = agreeing
    best_score = scored[0][1]
    top = [(r, s) for r, s in scored if s >= best_score - TIE_WINDOW]
    groups = {r.key for r, _ in top}
    ambiguous = len(groups) > 1
    chosen, score = top[0]

    verified, conflict = _strength_relation(rx_key, chosen.strength_key)
    basis: str = "prescription" if verified else "none"
    if (
        not verified
        and not conflict
        and allow_brand_number
        and _brand_number_confirms(query_name, chosen)
    ):
        basis = "brand_name"
    form_conflict = _form_conflict(rx_form, chosen.form_key)
    release_conflict = False
    if (
        rx_modified is not None
    ):  # fuzzy stages only: an exact brand name already implies its release
        release_conflict = rx_modified != (chosen.release_type not in {"ir", "na"})
        form_conflict = form_conflict or release_conflict
    note = (
        "strength_conflict"
        if conflict
        else "release_conflict"
        if release_conflict
        else "form_conflict"
        if form_conflict
        else "ambiguous"
        if ambiguous
        else None
    )
    if ambiguous:
        # Several products fit: only what ALL of them agree on is stated (often the salt), never a product.
        def agree(attr: str) -> str | None:
            values = {getattr(r, attr) for r, _ in top}
            return str(values.pop()) if len(values) == 1 else None

        return DrugMatch(
            salt_key=agree("salt_key"),
            strength_key=agree("strength_key"),
            form_key=agree("form_key"),
            release_type=agree("release_type"),
            score=round(min(score, 1.0), 3),
            method=method,
            candidates=_candidates(scored),
            ambiguous=True,
            note="ambiguous",
        )
    return DrugMatch(
        drug_id=chosen.id,
        brand_name=chosen.brand_name[:200],
        salt_key=chosen.salt_key,
        strength_key=chosen.strength_key,
        form_key=chosen.form_key,
        release_type=chosen.release_type,
        score=round(min(score, 1.0), 3),
        method=method,
        candidates=_candidates(scored),
        strength_basis=basis,  # type: ignore[arg-type]
        strength_conflict=conflict,
        form_conflict=form_conflict,
        ambiguous=ambiguous,
        note=note,
    )


def _salt_candidates(name: str, strength_text: str | None) -> tuple[str, str] | None:
    """(salt_key, strength_key) when the NAME is one or more salts and the strengths pair up."""
    strengths = find_strengths(strength_text or "") or find_strengths(name)
    cleaned = _FORM_WORDS.sub(" ", name)
    for _, (start, end) in sorted(find_strengths(cleaned), key=lambda item: -item[1][0]):
        cleaned = cleaned[:start] + " " + cleaned[end:]
    cleaned = re.sub(r"\d+(?:\.\d+)?", " ", cleaned)
    salts = split_salts(cleaned)
    if not salts or len(salts) != len(strengths):
        return None
    return build_keys(list(zip(salts, [s for s, _ in strengths], strict=True)))


async def _match_salt_written(
    name: str, strength_text: str | None, form_text: str | None, repo: CatalogRepository
) -> DrugMatch | None:
    keys = _salt_candidates(name, strength_text)
    if keys is None:
        return None
    salt, strength = keys
    rows = await repo.by_salt(salt, strength)
    if not rows:
        return None
    wanted_form = _written_form(name, form_text)
    candidates = [r for r in rows if wanted_form is None or r.form_key == wanted_form]
    if not candidates:
        return None
    # No modified-release word written -> the plain (immediate-release) product, never an SR/ER one.
    written_release = parse_release(f"{name} {form_text or ''}")
    groups = {r.release_type for r in candidates}
    if written_release in {"ir", "na"}:
        release = "ir" if "ir" in groups else ("na" if "na" in groups else None)
    else:
        release = written_release
    candidates = [r for r in candidates if r.release_type == release]
    if not candidates:
        return None
    forms = {r.form_key for r in candidates}
    chosen = candidates[0]
    return DrugMatch(
        drug_id=None,  # the prescription names a salt, not a product: there is no brand price to compare
        brand_name=None,
        salt_key=chosen.salt_key,
        strength_key=chosen.strength_key,
        form_key=chosen.form_key,
        release_type=chosen.release_type,
        score=SALT_WRITTEN_SCORE,
        method=MatchMethod.salt_written,
        candidates=_candidates([(r, SALT_WRITTEN_SCORE) for r in candidates]),
        strength_basis="prescription",
        ambiguous=len(forms) > 1,
        note="ambiguous" if len(forms) > 1 else None,
    )


async def match_drug(
    name: str,
    strength: str | None,
    form: str | None,
    *,
    repo: CatalogRepository,
    vector: VectorStore | None,
    config: MatcherConfig,
) -> DrugMatch:
    """Match one prescribed medicine. Never raises for "not found": that is `method=none`."""
    qkey = brand_key(name)
    if not qkey:
        return DrugMatch(note="empty_name")
    # One written strength is verified against the catalog. Several ("40 mg + 5 mg") are not: which
    # salt each belongs to is not written, so they stay unverified (no generic) rather than guessed.
    written = find_strengths(strength or "") or find_strengths(name)
    rx_strength = written[0][0] if len(written) == 1 else None
    rx_key = rx_strength.canon() if rx_strength else None
    rx_form = _written_form(name, form)
    rx_modified = parse_release(f"{name} {form or ''}") not in {"ir", "na"}

    # 1. exact brand (also "dolo" + written 650 mg -> dolo650)
    keys = [qkey]
    if (
        rx_strength is not None
        and rx_strength.per_unit is None
        and rx_strength.amount == rx_strength.amount.to_integral_value()
    ):
        keys.append(qkey + str(int(rx_strength.amount)))
    for key in keys:
        rows = await repo.exact_brand(key)
        if rows:
            return _finish(
                [(r, 1.0) for r in rows],
                method=MatchMethod.exact, rx_key=rx_key, rx_form=rx_form,
                query_name=name, allow_brand_number=True,
            )  # fmt: skip

    # 2. the prescription wrote the generic name
    by_salt = await _match_salt_written(name, strength, form, repo)
    if by_salt is not None:
        return by_salt

    # 3. trigram on the brand key
    hits: list[tuple[DrugRow, float]] = []
    for key in keys:
        hits += await repo.trgm_brand(key, config.trgm_min, 10)
    if len(qkey) >= PREFIX_MIN_LEN:
        # "dolo" / "डोलो" is the start of "dolo650": trigram similarity alone stays just under the bar.
        seen = {row.id for row, _ in hits}
        for row in await repo.prefix_brand(qkey, 10):
            if row.id not in seen:
                hits.append((row, PREFIX_BASE + PREFIX_SPAN * len(qkey) / len(row.brand_key)))
    if hits:
        boosted = []
        for row, sim in hits:
            verified, _ = _strength_relation(rx_key, row.strength_key)
            boosted.append((row, min(1.0, sim + STRENGTH_BOOST) if verified else sim))
        boosted.sort(key=lambda pair: (-pair[1], pair[0].price_per_unit is None))
        return _finish(
            boosted,
            method=MatchMethod.trgm, rx_key=rx_key, rx_form=rx_form,
            query_name=name, allow_brand_number=True, rx_modified=rx_modified,
        )  # fmt: skip

    # 4. vector fallback, only when the stages above found nothing
    if vector is not None:
        found = [
            (i, s)
            for i, s in await vector.query(query_text(name, strength, form), 5)
            if s >= config.vector_min
        ]
        if found:
            by_id = {r.id: r for r in await repo.by_ids([i for i, _ in found])}
            scored = [(by_id[i], min(s, VECTOR_SCORE_CAP)) for i, s in found if i in by_id]
            if scored:
                return _finish(
                    scored,
                    method=MatchMethod.vector, rx_key=rx_key, rx_form=rx_form,
                    query_name=name, allow_brand_number=False, rx_modified=rx_modified,
                )  # fmt: skip

    return DrugMatch(note="no_match")
