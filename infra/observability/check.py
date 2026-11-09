"""Static checks for the observability config (M15). Run by `make check-obs` and in CI. No Docker needed.

  1. every Grafana dashboard is valid JSON with unique panel ids and known datasources
  2. every metric named in a dashboard or an alert rule is really exported by one of the apps
  3. every alert has severity, summary and a runbook_url that points at an existing file
  4. the committed dashboards are what build_dashboards.py generates (no hand edits)

`promtool check rules` is run separately (CI and `make check-obs` when Docker is available).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
OBS = ROOT / "infra" / "observability"
DASHBOARDS = OBS / "grafana" / "dashboards"
GATEWAY_METRICS = ROOT / "apps" / "gateway" / "src" / "telemetry" / "metrics.service.ts"
AI_METRICS = ROOT / "apps" / "ai-service" / "app" / "observability" / "metrics.py"

PROMQL_KEYWORDS = {
    "sum", "rate", "increase", "by", "without", "histogram_quantile", "clamp_min", "count", "max",
    "min", "avg", "vector", "and", "or", "unless", "on", "ignoring", "group_left", "group_right",
    "bool", "le", "job", "queue", "status", "intent", "type", "kind", "code", "reason", "scope",
    "model", "node", "provider", "direction", "category", "source", "state", "alertstate",
    "firing", "pending", "inf", "nan", "ALERTS",
}
BUILTIN_METRICS = {"up", "ALERTS"}


def exported_metrics() -> set[str]:
    names = set(re.findall(r"name:\s*'([a-z0-9_]+)'", GATEWAY_METRICS.read_text(encoding="utf-8")))
    py = AI_METRICS.read_text(encoding="utf-8")
    names |= set(re.findall(r'(?:Counter|Histogram|Gauge)\(\s*"([a-z0-9_]+)"', py))
    full = set(names)
    for name in names:  # histogram series
        full |= {f"{name}_bucket", f"{name}_count", f"{name}_sum"}
    return full | BUILTIN_METRICS


def recorded_names(rules: dict) -> set[str]:
    return {r["record"] for g in rules["groups"] for r in g["rules"] if "record" in r}


def metric_tokens(expr: str, known: set[str]) -> set[str]:
    cleaned = re.sub(r'"[^"]*"', '""', expr)  # drop label values
    cleaned = re.sub(r"\{[^}]*\}", "", cleaned)  # drop label matchers
    cleaned = re.sub(r"\[[^\]]*\]", "", cleaned)  # range selectors such as [5m]
    cleaned = re.sub(r"\b\d+(?:\.\d+)?(?:e-?\d+)?\b", "", cleaned)  # numbers such as 0.95 or 1e-9
    cleaned = re.sub(r"\b(by|without|on|ignoring)\s*\([^)]*\)", "", cleaned)
    tokens = set(re.findall(r"[a-zA-Z_:][a-zA-Z0-9_:]*", cleaned))
    return {t for t in tokens if t not in PROMQL_KEYWORDS and not t.isdigit() and not re.fullmatch(r"\d+[smhd]", t)}


def main() -> int:
    problems: list[str] = []
    metrics = exported_metrics()
    rules = yaml.safe_load((OBS / "alerts.yml").read_text(encoding="utf-8"))
    recorded = recorded_names(rules)
    known = metrics | recorded

    # ---- alerts
    for group in rules["groups"]:
        for rule in group["rules"]:
            expr = rule["expr"]
            for token in metric_tokens(expr, known):
                if token not in known:
                    problems.append(f"alert/record {rule.get('alert') or rule.get('record')}: unknown metric {token}")
            if "alert" in rule:
                notes = rule.get("annotations", {})
                if "severity" not in rule.get("labels", {}):
                    problems.append(f"alert {rule['alert']}: no severity label")
                if not notes.get("summary"):
                    problems.append(f"alert {rule['alert']}: no summary")
                runbook = notes.get("runbook_url")
                if not runbook or not (ROOT / runbook).is_file():
                    problems.append(f"alert {rule['alert']}: runbook_url {runbook!r} is not a file")

    # ---- dashboards
    seen_uids: set[str] = set()
    boards = sorted(DASHBOARDS.glob("*.json"))
    if len(boards) != 6:
        problems.append(f"expected 6 dashboards, found {len(boards)}")
    for path in boards:
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc["uid"] in seen_uids:
            problems.append(f"{path.name}: duplicate uid")
        seen_uids.add(doc["uid"])
        ids = [p["id"] for p in doc["panels"]]
        if len(ids) != len(set(ids)):
            problems.append(f"{path.name}: duplicate panel ids")
        if not doc["panels"]:
            problems.append(f"{path.name}: no panels")
        for panel in doc["panels"]:
            if panel["datasource"].get("uid") not in {"prometheus", "loki", "tempo"}:
                problems.append(f"{path.name}/{panel['title']}: unknown datasource")
            if panel["type"] == "logs":
                continue
            for target in panel["targets"]:
                for token in metric_tokens(target["expr"], known):
                    if token not in known:
                        problems.append(f"{path.name}/{panel['title']}: unknown metric {token}")

    # ---- generated == committed
    before = {p.name: p.read_text(encoding="utf-8") for p in boards}
    subprocess.run([sys.executable, str(OBS / "grafana" / "build_dashboards.py")], check=True, capture_output=True)
    for path in sorted(DASHBOARDS.glob("*.json")):
        if before.get(path.name) != path.read_text(encoding="utf-8"):
            problems.append(f"{path.name}: differs from build_dashboards.py output (re-run it and commit)")

    for problem in problems:
        print("FAIL", problem)
    print(f"checked {len(boards)} dashboards, {sum(len(g['rules']) for g in rules['groups'])} rules, {len(metrics)} exported series names")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
