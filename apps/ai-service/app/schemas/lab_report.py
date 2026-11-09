"""Lab report schemas (M12, CLAUDE.md §8.2 `LabReportExtraction`).

Same design rules as the prescription schema:
  * every read value carries its own confidence (`Field`);
  * PHI minimisation (§2.6): there is NO field for patient name, lab/hospital/patient ids, doctor,
    address or phone. Only age and sex are read, because reference ranges need them. `extra="forbid"`
    makes an unexpected key (a misbehaving model returning "patient_name") fail validation;
  * everything under "set by OUR code" is overwritten after the model answered: a model-supplied value
    never survives, so the status of a result is always computed by deterministic code.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic import Field as PydField

from app.schemas.prescription import DateField, Field, IntField, TextField

MAX_RESULTS = 80
MAX_NOTES = 5

LabFlag = Literal["H", "L", "N", "A"]
Sex = Literal["m", "f"]
# normal | high | low | borderline (inside the range, within 5% of a limit) | critical_* | a qualitative
# test that is not in its normal state | unknown (not enough certain information to compare)
ResultStatus = Literal[
    "normal",
    "high",
    "low",
    "borderline",
    "critical_high",
    "critical_low",
    "qualitative_abnormal",
    "unknown",
]
RangeBasis = Literal["printed", "flag", "fallback", "none"]
TrendDirection = Literal["up", "down", "same"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FloatField(Field[float]): ...


class FlagField(Field[LabFlag]): ...


class SexField(Field[Sex]): ...


class Trend(_Model):
    """Change since the user's previous report (canonical units). No judgement: only the direction and,
    when the printed/fallback range makes it unambiguous, whether the value moved into / out of range."""

    direction: TrendDirection
    previous_value: float
    previous_date: date
    unit: str
    range_change: Literal["into_range", "out_of_range"] | None = None


class LabResult(_Model):
    raw_test_name: TextField  # as printed, e.g. "HbA1c (Glycated Haemoglobin)"
    value_raw: TextField  # "7.2", "<0.5", "Positive", "1.2 x 10^3"
    unit: TextField  # as printed
    lab_ref_low: FloatField  # the lab's printed reference range (preferred source)
    lab_ref_high: FloatField
    lab_ref_text: TextField  # "Non-diabetic: <5.7, Pre-diabetic: 5.7-6.4"
    lab_flag: FlagField  # flag printed by the lab, if any
    section: str | None = PydField(default=None, max_length=80)  # "CBC", "Lipid Profile", ...

    # ---- set by OUR code (lab_normalize / lab_compare); a model-supplied value is overwritten
    test_code: str | None = None  # canonical code after normalisation
    value_num: float | None = None  # parsed number as printed (no unit conversion)
    value_comparator: Literal["<", ">", "="] = "="
    value_canonical: float | None = None  # in the test's canonical unit (null when not convertible)
    unit_canonical: str | None = None
    status: ResultStatus = "unknown"
    range_basis: RangeBasis = "none"
    range_text: str | None = None  # the range the status was computed against, as shown to the user
    category: str | None = (
        None  # a printed category label ("Pre-diabetic"), verbatim, never invented
    )
    needs_confirmation: bool = False  # low confidence on name/value/unit/range: "please confirm"
    trend: Trend | None = None


class LabReportExtraction(_Model):
    kind: Literal["lab_report"] = "lab_report"
    is_lab_report: bool
    image_quality: Literal["good", "poor", "unreadable"]
    report_date: DateField
    patient_age: IntField  # only age and sex, needed for the ranges; kept on the document only
    patient_sex: SexField
    results: list[LabResult] = PydField(default_factory=list, max_length=MAX_RESULTS)
    overall_confidence: float = PydField(default=0.0, ge=0.0, le=1.0)
    notes_for_user: list[str] = PydField(default_factory=list, max_length=MAX_NOTES)

    # ---- set by OUR code
    status: Literal["done", "needs_review", "failed"] = "done"
    has_critical: bool = False
    # True when a fallback range had to be used without a known age or sex ("general adult range")
    used_general_range: bool = False
    # number of results that stayed "unknown" and are listed as "other tests / please confirm"
    unknown_count: int = 0


__all__ = [
    "MAX_RESULTS",
    "FlagField",
    "FloatField",
    "LabFlag",
    "LabReportExtraction",
    "LabResult",
    "RangeBasis",
    "ResultStatus",
    "SexField",
    "Trend",
    "TrendDirection",
]
