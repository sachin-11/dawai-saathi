"""Lab test reference data behind a small interface (M12).

`PgLabRepository` reads the shared `lab_tests` table on the read-only session; `InMemoryLabRepository`
holds the same data built from `data/seed/lab_tests.yaml` so unit tests, the eval and fake mode need no
database. Both return the SAME `LabTest` objects: one test code with all its range variants.
"""

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import yaml
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.safety.critical_values import CriticalValues, load_critical_values

SEED_FILE = Path(__file__).resolve().parents[4] / "data" / "seed" / "lab_tests.yaml"


@dataclass(frozen=True, slots=True)
class RangeVariant:
    sex: str  # any | m | f
    age_min: int | None
    age_max: int | None
    low: float | None
    high: float | None


@dataclass(frozen=True, slots=True)
class Conversion:
    """canonical = printed * factor + offset"""

    factor: float
    offset: float = 0.0


@dataclass(frozen=True, slots=True)
class LabTest:
    code: str
    name: str
    section: str
    unit: str  # canonical unit (normalised spelling)
    aliases: tuple[str, ...]
    conversions: Mapping[str, Conversion]
    ranges: tuple[RangeVariant, ...]
    qualitative_normal: tuple[str, ...]  # non-empty for qualitative tests
    explanation_en: str
    explanation_hi: str
    hi_reviewed: bool
    questions_en: tuple[str, ...]
    questions_hi: tuple[str, ...]
    source: str
    critical_low: float | None = None
    critical_high: float | None = None

    @property
    def is_qualitative(self) -> bool:
        return bool(self.qualitative_normal)


class LabRepository(Protocol):
    async def all_tests(self) -> list[LabTest]: ...


# ------------------------------------------------------------------ building from the seed file


def _conversions(raw: Mapping[str, Any] | None) -> dict[str, Conversion]:
    out: dict[str, Conversion] = {}
    for unit, spec in (raw or {}).items():
        if isinstance(spec, Mapping):
            out[str(unit)] = Conversion(float(spec["f"]), float(spec.get("o", 0.0)))
        else:
            out[str(unit)] = Conversion(float(spec))
    return out


def build_lab_tests(
    data: Mapping[str, Any], critical: CriticalValues | None = None
) -> list[LabTest]:
    critical = critical if critical is not None else load_critical_values()
    generic_en = tuple(data.get("generic_questions_en", []))
    generic_hi = tuple(data.get("generic_questions_hi", []))
    hi_line = str(data.get("generic_hi_line", ""))
    tests: list[LabTest] = []
    for item in data["tests"]:
        ranges = tuple(RangeVariant(str(r[0]), r[1], r[2], r[3], r[4]) for r in item.get("r", []))
        limits = critical.get(item["code"])
        tests.append(
            LabTest(
                code=item["code"],
                name=item["name"],
                section=item["section"],
                unit=str(item.get("unit", "")),
                aliases=tuple(str(a) for a in item.get("aliases", [])),
                conversions=_conversions(item.get("conv")),
                ranges=ranges,
                qualitative_normal=tuple(item.get("qual", [])),
                explanation_en=item["ex"],
                explanation_hi=hi_line,  # a safe generic line until a human reviews (hi_reviewed)
                hi_reviewed=False,
                questions_en=(*item.get("q", []), *generic_en),
                questions_hi=generic_hi,
                source=str(item.get("src", "")),
                critical_low=limits.low if limits else None,
                critical_high=limits.high if limits else None,
            )
        )
    return tests


def load_seed(path: Path = SEED_FILE) -> dict[str, Any]:
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)  # noqa: S101
    return loaded


class InMemoryLabRepository:
    def __init__(self, tests: Iterable[LabTest] | None = None) -> None:
        self._tests = list(tests) if tests is not None else build_lab_tests(load_seed())

    async def all_tests(self) -> list[LabTest]:
        return list(self._tests)


class FailingLabRepository:
    async def all_tests(self) -> list[LabTest]:
        raise ConnectionError("lab database unavailable")


# ------------------------------------------------------------------ Postgres


class PgLabRepository:
    """One row per (code, sex, age band) in `lab_tests`; rows of a code are folded into one LabTest."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory

    async def all_tests(self) -> list[LabTest]:
        sql = (
            "SELECT code, name, aliases, section, unit, unit_conversions, "
            "ref_low::float8 AS ref_low, ref_high::float8 AS ref_high, sex::text AS sex, "
            "age_min, age_max, critical_low::float8 AS critical_low, "
            "critical_high::float8 AS critical_high, explanation_en, explanation_hi, "
            "doctor_questions_en, doctor_questions_hi, qualitative_normal, hi_reviewed, source "
            "FROM lab_tests ORDER BY code, sex, age_min NULLS FIRST"
        )
        async with self._sessions() as session:
            result = await session.execute(text(sql))
            rows = [dict(r) for r in result.mappings().all()]
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(str(row["code"]), []).append(row)
        tests: list[LabTest] = []
        for code, group in grouped.items():
            first = group[0]
            conv = first["unit_conversions"]
            if isinstance(conv, str):
                conv = json.loads(conv)
            ranges = tuple(
                RangeVariant(str(r["sex"]), r["age_min"], r["age_max"], r["ref_low"], r["ref_high"])
                for r in group
                if r["ref_low"] is not None or r["ref_high"] is not None
            )
            tests.append(
                LabTest(
                    code=code,
                    name=str(first["name"]),
                    section=str(first["section"] or ""),
                    unit=str(first["unit"]),
                    aliases=tuple(first["aliases"] or ()),
                    conversions=_conversions(conv),
                    ranges=ranges,
                    qualitative_normal=tuple(first["qualitative_normal"] or ()),
                    explanation_en=str(first["explanation_en"]),
                    explanation_hi=str(first["explanation_hi"]),
                    hi_reviewed=bool(first["hi_reviewed"]),
                    questions_en=tuple(first["doctor_questions_en"] or ()),
                    questions_hi=tuple(first["doctor_questions_hi"] or ()),
                    source=str(first["source"]),
                    critical_low=first["critical_low"],
                    critical_high=first["critical_high"],
                )
            )
        return tests
