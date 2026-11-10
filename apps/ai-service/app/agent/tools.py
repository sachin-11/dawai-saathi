"""Read-only tools for the Q&A agent. Each one wraps code the pipeline already trusts.

A tool returns a `ToolResult`: `data` (structured, what the checks compare against) and `text`
(rendered by a template, never by a model). No tool writes anything and none sees user state.
"""

from dataclasses import dataclass, field
from typing import Any

from app.catalog.service import CatalogService
from app.interactions.render import render_block
from app.interactions.service import InteractionService, typed_medications
from app.labs.service import LabService
from app.schemas.process import Language
from app.tools.lab_render import render_lab_question

MAX_NAMES = 6
MAX_NAME_CHARS = 80
MAX_CALLS = 5  # per question: an agent loop must have a ceiling (cost, abuse)


@dataclass(frozen=True, slots=True)
class ToolResult:
    tool: str
    data: dict[str, Any]
    text: str


@dataclass(slots=True)
class QATools:
    catalog: CatalogService
    interactions: InteractionService
    labs: LabService
    language: Language
    match_min: float = 0.8
    calls: list[ToolResult] = field(default_factory=list)

    def _budget_left(self) -> bool:
        return len(self.calls) < MAX_CALLS

    def _record(self, result: ToolResult) -> ToolResult:
        self.calls.append(result)
        return result

    async def lookup_medicine(self, name: str) -> ToolResult:
        """Brand/generic name -> salt, strength and form from the catalog (never from a model)."""
        name = (name or "").strip()[:MAX_NAME_CHARS]
        if not self._budget_left():
            return ToolResult("lookup_medicine", {"error": "limit"}, "")
        if not name:
            return self._record(ToolResult("lookup_medicine", {"matched": False}, ""))
        match = await self.catalog.match(name, None, None)
        confident = match.score >= self.match_min and match.salt_key is not None
        data: dict[str, Any] = {"queried": name, "matched": confident}
        if confident:
            data.update(
                brand=match.brand_name,
                salt=match.salt_key,
                strength=match.strength_key,
                form=match.form_key,
            )
            lines = [f"💊 {match.brand_name or name}", f"Salt: {match.salt_key}"]
            if match.strength_key:
                lines.append(f"Strength: {match.strength_key}")
            if match.form_key:
                lines.append(f"Form: {match.form_key}")
            text = "\n".join(lines)
        else:
            text = (
                f"I could not identify “{name}” with confidence. "
                "Please check the name on the strip with your pharmacist."
            )
        return self._record(ToolResult("lookup_medicine", data, text))

    async def check_interactions(self, names: list[str]) -> ToolResult:
        """Known interactions between the named medicines (rows of the interaction table only)."""
        if not self._budget_left():
            return ToolResult("check_interactions", {"error": "limit"}, "")
        cleaned = [n.strip()[:MAX_NAME_CHARS] for n in names if n and n.strip()][:MAX_NAMES]
        if len(cleaned) < 2:
            return self._record(
                ToolResult(
                    "check_interactions",
                    {"names": cleaned, "checked": 0},
                    "Please name at least two medicines to check.",
                )
            )
        matches = [await self.catalog.match(n, None, None) for n in cleaned]
        known = await self.interactions.known_salts()
        medicines = typed_medications(cleaned, matches, match_min=self.match_min, known_salts=known)
        report = await self.interactions.check(medicines, only_new=True)
        text = render_block(report, self.language, query=True)
        data: dict[str, Any] = {
            "names": cleaned,
            "checked": report.checked_count,
            "database_ok": report.database_ok,
            "findings": [
                {"a": f.salt_a, "b": f.salt_b, "type": f.type, "severity": f.severity}
                for f in report.findings
            ],
        }
        return self._record(ToolResult("check_interactions", data, text))

    async def explain_lab_test(self, test_name: str, value: str | None = None) -> ToolResult:
        """What a lab test measures + the typical adult range. Never an interpretation of a value."""
        if not self._budget_left():
            return ToolResult("explain_lab_test", {"error": "limit"}, "")
        index = await self.labs.index()
        name = (test_name or "").strip()[:MAX_NAME_CHARS]
        if index is None or not name:
            return self._record(
                ToolResult(
                    "explain_lab_test", {"matched": False}, "Lab information is not available."
                )
            )
        match = index.match(name, None)
        answer = render_lab_question(match.test if match else None, value, self.language)
        data: dict[str, Any] = {"queried": name, "matched": answer.test_code is not None}
        if answer.test_code:
            data["code"] = answer.test_code
        if value:
            data["value"] = value[:20]
        return self._record(ToolResult("explain_lab_test", data, answer.text))
