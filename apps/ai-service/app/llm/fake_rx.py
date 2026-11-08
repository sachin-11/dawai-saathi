"""Canned answers of the fake LLM for the prescription flow (M7), so fake mode and CI need no keys.

`LLM_MODE=fake` + a photo -> a fixed sample prescription (two clear medicines and one unreadable
line). That is enough to see the whole flow (reply, buttons, saved rows) on a laptop. The fake never
looks at the picture: real reading quality can only be measured with a real model
(`make eval-rx MODE=real`).
"""

import json
import re
from typing import Any

SAMPLE_EXTRACTION: dict[str, Any] = {
    "kind": "prescription",
    "is_prescription": True,
    "image_quality": "good",
    "medicines": [
        {
            "raw_text": {"value": "Tab. Dolo 650 1-0-1 x 5 days (after food)", "confidence": 0.95},
            "name": {"value": "Dolo 650", "confidence": 0.95},
            "form": {"value": "tablet", "confidence": 0.95},
            "strength": {"value": "650 mg", "confidence": 0.8},
            "dose": {"value": "1 tablet", "confidence": 0.92},
            "frequency_code": {"value": "1-0-1", "confidence": 0.95},
            "frequency_per_day": {"value": 2, "confidence": 0.95},
            "timings": {"value": ["morning", "night"], "confidence": 0.9},
            "relation_to_food": {"value": "after", "confidence": 0.9},
            "duration_days": {"value": 5, "confidence": 0.95},
            "as_needed": False,
            "instructions": {"value": None, "confidence": 0.0},
        },
        {
            "raw_text": {"value": "Tab. Pantop 40 1-0-0 AC x 10 days", "confidence": 0.93},
            "name": {"value": "Pantop 40", "confidence": 0.93},
            "form": {"value": "tablet", "confidence": 0.93},
            "strength": {"value": None, "confidence": 0.3},
            "dose": {"value": "1 tablet", "confidence": 0.9},
            "frequency_code": {"value": "1-0-0", "confidence": 0.93},
            "frequency_per_day": {"value": 1, "confidence": 0.93},
            "timings": {"value": ["morning"], "confidence": 0.9},
            "relation_to_food": {"value": "before", "confidence": 0.9},
            "duration_days": {"value": 10, "confidence": 0.93},
            "as_needed": False,
            "instructions": {"value": None, "confidence": 0.0},
        },
        {
            "raw_text": {"value": "Tab. ?????? 1-0-1", "confidence": 0.3},
            "name": {"value": None, "confidence": 0.2},
            "form": {"value": "tablet", "confidence": 0.7},
            "strength": {"value": None, "confidence": 0.0},
            "dose": {"value": "1 tablet", "confidence": 0.6},
            "frequency_code": {"value": "1-0-1", "confidence": 0.8},
            "frequency_per_day": {"value": 2, "confidence": 0.8},
            "timings": {"value": None, "confidence": 0.0},
            "relation_to_food": {"value": None, "confidence": 0.0},
            "duration_days": {"value": None, "confidence": 0.0},
            "as_needed": False,
            "instructions": {"value": None, "confidence": 0.0},
        },
    ],
    "prescription_date": {"value": None, "confidence": 0.0},
    "overall_confidence": 0.2,
    "notes_for_user": [],
}

SAMPLE_CLASSIFICATION: dict[str, Any] = {
    "kind": "prescription",
    "quality": "good",
    "confidence": 0.95,
}

_FOOD_EN = {"before": "before food", "after": "after food", "with": "with food"}
_FOOD_HI = {"before": "खाने से पहले", "after": "खाने के बाद", "with": "खाने के साथ"}
_TIME_EN = {"morning": "morning", "afternoon": "afternoon", "evening": "evening", "night": "night"}
_TIME_HI = {"morning": "सुबह", "afternoon": "दोपहर", "evening": "शाम", "night": "रात"}


def fake_compose(messages_text: list[str], last_user: str) -> str:
    """A grounded one-line-per-medicine answer built from the JSON the composer was given."""
    hindi = any("Language: Hindi" in text for text in messages_text)
    data = json.loads(last_user)
    items = []
    for medicine in data["medicines"]:
        parts: list[str] = []
        if medicine.get("dose"):
            dose = medicine["dose"]
            parts.append(re.sub(r"tablets?", "गोली", dose) if hindi else dose)
        if medicine.get("as_needed"):
            parts.append("ज़रूरत पड़ने पर" if hindi else "as needed")
        elif medicine.get("timings"):
            names = [(_TIME_HI if hindi else _TIME_EN)[t] for t in medicine["timings"]]
            parts.append((" और " if hindi else " and ").join(names))
        if medicine.get("food"):
            parts.append((_FOOD_HI if hindi else _FOOD_EN)[medicine["food"]])
        if medicine.get("duration_days"):
            days = medicine["duration_days"]
            parts.append(f"{days} दिन" if hindi else f"for {days} days")
        line = medicine["name"] + (" — " + ", ".join(parts) if parts else "")
        items.append({"index": medicine["index"], "text": line})
    return json.dumps({"items": items}, ensure_ascii=False)
