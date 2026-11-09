"""Generate the six Grafana dashboards as JSON (M15). The JSON is committed; this script is the source.

    python infra/observability/grafana/build_dashboards.py

Every expression uses metrics the apps really export; `infra/observability/check.py` fails CI when a
dashboard or an alert names a metric that does not exist.
"""

import json
from pathlib import Path
from typing import Any

OUT = Path(__file__).parent / "dashboards"
PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}

GREEN, YELLOW, ORANGE, RED = "#2f9e44", "#e8b600", "#e8590c", "#e03131"


class Board:
    def __init__(self, uid: str, title: str, description: str) -> None:
        self.uid, self.title, self.description = uid, title, description
        self.panels: list[dict[str, Any]] = []
        self._id = 0
        self._row_y = 0
        self._x = 0
        self._row_h = 0

    def _place(self, w: int, h: int) -> dict[str, int]:
        if self._x + w > 24:
            self._row_y += self._row_h
            self._x, self._row_h = 0, 0
        pos = {"x": self._x, "y": self._row_y, "w": w, "h": h}
        self._x += w
        self._row_h = max(self._row_h, h)
        return pos

    def _base(self, kind: str, title: str, w: int, h: int, desc: str | None) -> dict[str, Any]:
        self._id += 1
        return {
            "id": self._id,
            "type": kind,
            "title": title,
            "description": desc or "",
            "datasource": PROM,
            "gridPos": self._place(w, h),
        }

    @staticmethod
    def _targets(exprs: list[tuple[str, str]], ds: dict[str, str] = PROM) -> list[dict[str, Any]]:
        return [
            {"refId": chr(65 + i), "expr": e, "legendFormat": legend, "datasource": ds}
            for i, (e, legend) in enumerate(exprs)
        ]

    def stat(
        self,
        title: str,
        expr: str,
        *,
        unit: str = "short",
        w: int = 4,
        h: int = 4,
        steps: list[tuple[float | None, str]] | None = None,
        desc: str | None = None,
        decimals: int | None = None,
    ) -> None:
        panel = self._base("stat", title, w, h, desc)
        panel["targets"] = self._targets([(expr, "")])
        defaults: dict[str, Any] = {
            "unit": unit,
            "thresholds": {
                "mode": "absolute",
                "steps": [{"color": c, "value": v} for v, c in (steps or [(None, GREEN)])],
            },
        }
        if decimals is not None:
            defaults["decimals"] = decimals
        # an empty result is "no data", not a bad value: grey, never the colour of the first threshold step
        defaults["mappings"] = [
            {"type": "special", "options": {"match": "null", "result": {"text": "no data", "color": "#868e96"}}}
        ]
        panel["fieldConfig"] = {"defaults": defaults, "overrides": []}
        panel["options"] = {"colorMode": "background", "graphMode": "none", "textMode": "value"}
        self.panels.append(panel)

    def series(
        self,
        title: str,
        exprs: list[tuple[str, str]],
        *,
        unit: str = "short",
        w: int = 12,
        h: int = 8,
        desc: str | None = None,
        stack: bool = False,
        lines: list[tuple[float, str]] | None = None,
    ) -> None:
        panel = self._base("timeseries", title, w, h, desc)
        panel["targets"] = self._targets(exprs)
        custom: dict[str, Any] = {"lineWidth": 1, "fillOpacity": 12 if not stack else 40}
        if stack:
            custom["stacking"] = {"mode": "normal", "group": "A"}
        if lines:
            custom["thresholdsStyle"] = {"mode": "line"}
        defaults: dict[str, Any] = {"unit": unit, "custom": custom}
        if lines:
            defaults["thresholds"] = {
                "mode": "absolute",
                "steps": [{"color": GREEN, "value": None}]
                + [{"color": c, "value": v} for v, c in lines],
            }
        panel["fieldConfig"] = {"defaults": defaults, "overrides": []}
        panel["options"] = {
            "legend": {"displayMode": "list", "placement": "bottom"},
            "tooltip": {"mode": "multi"},
        }
        self.panels.append(panel)

    def heatmap(self, title: str, expr: str, *, w: int = 12, h: int = 8, desc: str | None = None) -> None:
        panel = self._base("heatmap", title, w, h, desc)
        panel["targets"] = [
            {"refId": "A", "expr": expr, "format": "heatmap", "legendFormat": "{{le}}", "datasource": PROM}
        ]
        panel["options"] = {"calculate": False, "yAxis": {"unit": "ms"}, "color": {"scheme": "Oranges"}}
        self.panels.append(panel)

    def logs(self, title: str, expr: str, *, w: int = 24, h: int = 8) -> None:
        panel = self._base("logs", title, w, h, None)
        panel["datasource"] = LOKI
        panel["targets"] = self._targets([(expr, "")], LOKI)
        panel["options"] = {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending"}
        self.panels.append(panel)

    def write(self) -> None:
        doc = {
            "uid": self.uid,
            "title": self.title,
            "description": self.description,
            "tags": ["dawai", "m15"],
            "timezone": "browser",
            "schemaVersion": 39,
            "version": 1,
            "refresh": "30s",
            "time": {"from": "now-6h", "to": "now"},
            "editable": False,
            "panels": self.panels,
            "templating": {"list": []},
            "annotations": {"list": []},
        }
        (OUT / f"{self.uid}.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def overview() -> None:
    b = Board("dawai-overview", "1. Overview and SLOs", "Is the service healthy, and how much error budget is left?")
    b.stat("Inbound / min", 'sum(rate(wa_inbound_total{job="gateway"}[5m])) * 60', decimals=1)
    b.stat(
        "Served (1h)",
        "100 * (1 - slo:inbound_unserved:ratio_rate1h)",
        unit="percent",
        decimals=2,
        steps=[(None, RED), (99, YELLOW), (99.5, GREEN)],
        desc="SLO 2: 99.5% of inbound messages served (none dead-lettered).",
    )
    b.stat(
        "Documents within 30 s (1h)",
        "100 * (1 - slo:reply_slow_documents:ratio_rate1h)",
        unit="percent",
        decimals=1,
        steps=[(None, RED), (90, YELLOW), (95, GREEN)],
        desc="SLO 1a: 95% of prescription / lab replies within 30 s.",
    )
    b.stat(
        "Text within 10 s (1h)",
        "100 * (1 - slo:reply_slow_text:ratio_rate1h)",
        unit="percent",
        decimals=1,
        steps=[(None, RED), (97, YELLOW), (99, GREEN)],
        desc="SLO 1b: 99% of text replies within 10 s.",
    )
    b.stat(
        "Reminders within 2 min (1h)",
        "100 * (1 - slo:reminder_late:ratio_rate1h)",
        unit="percent",
        decimals=1,
        steps=[(None, RED), (97, YELLOW), (99, GREEN)],
        desc="SLO 3.",
    )
    b.stat(
        "Alerts firing",
        'count(ALERTS{alertstate="firing"}) or vector(0)',
        steps=[(None, GREEN), (1, RED)],
    )
    b.series(
        "Reply latency p50 / p95 by intent (ms)",
        [
            ("dawai:reply_latency_ms:p50", "p50 {{intent}}"),
            ("dawai:reply_latency_ms:p95", "p95 {{intent}}"),
        ],
        unit="ms",
        desc="Inbound message received -> final reply accepted by WhatsApp.",
    )
    b.series(
        "Error-budget burn rate (1h window)",
        [
            ("slo:reply_slow_documents:ratio_rate1h / 0.05", "documents (30 s)"),
            ("slo:reply_slow_text:ratio_rate1h / 0.01", "text (10 s)"),
            ("slo:inbound_unserved:ratio_rate1h / 0.005", "served"),
            ("slo:reminder_late:ratio_rate1h / 0.01", "reminders"),
        ],
        lines=[(6, YELLOW), (14.4, RED)],
        desc="1 = spending the budget exactly as fast as the SLO allows. 14.4 pages.",
    )
    b.series(
        "Inbound by type (per min)",
        [('sum by (type) (rate(wa_inbound_total{job="gateway"}[5m])) * 60', "{{type}}")],
        stack=True,
    )
    b.series(
        "Webhook latency p95 (ms)",
        [
            (
                'histogram_quantile(0.95, sum by (le) (rate(webhook_latency_ms_bucket{job="gateway"}[5m])))',
                "p95 latency",
            )
        ],
        unit="ms",
        desc="Meta times out at about 5 s; the handler only stores and enqueues.",
    )
    b.write()


def queues() -> None:
    b = Board("dawai-queues", "2. Queues and workers", "Backlog, waiting time, failures and dead letters.")
    b.series("Queue depth (waiting jobs)", [('queue_depth{job="gateway"}', "{{queue}}")])
    b.series("Queue wait p95 (ms)", [("dawai:queue_wait_ms:p95", "{{queue}}")], unit="ms", lines=[(60000, RED)])
    b.series(
        "Job duration p95 (ms)",
        [('histogram_quantile(0.95, sum by (queue, le) (rate(job_duration_ms_bucket{job="gateway"}[5m])))', "{{queue}}")],
        unit="ms",
    )
    b.series(
        "Failed attempts by queue and reason (per min)",
        [('sum by (queue, reason) (rate(job_failed_total{job="gateway"}[5m])) * 60', "{{queue}} / {{reason}}")],
        stack=True,
    )
    b.stat(
        "DLQ: inbound",
        'max(dlq_size{job="gateway",queue="inbound"}) or vector(0)',
        steps=[(None, GREEN), (1, RED)],
    )
    b.stat(
        "DLQ: outbound",
        'max(dlq_size{job="gateway",queue="outbound"}) or vector(0)',
        steps=[(None, GREEN), (1, RED)],
    )
    b.stat(
        "DLQ: reminders",
        'max(dlq_size{job="gateway",queue="reminders"}) or vector(0)',
        steps=[(None, GREEN), (1, RED)],
    )
    b.stat(
        "DLQ: user-deletion",
        'max(dlq_size{job="gateway",queue="user-deletion"}) or vector(0)',
        steps=[(None, GREEN), (1, RED)],
        desc="Erasure is a legal obligation: any value above 0 pages.",
    )
    b.series(
        "Moved to a dead-letter queue (per hour)",
        [('sum by (queue) (increase(dlq_moved_total{job="gateway"}[1h]))', "{{queue}}")],
        w=12,
        h=6,
    )
    b.series(
        "Rate limited (per min) and automatic blocks (per hour)",
        [
            ('sum by (scope) (rate(rate_limited_total{job="gateway"}[5m])) * 60', "limited {{scope}}"),
            ('sum by (reason) (increase(user_blocked_total{job="gateway"}[1h]))', "blocked {{reason}}"),
        ],
        w=12,
        h=6,
    )
    b.logs("Dead-letter events", '{service_name="gateway"} |= "job_dead_lettered"')
    b.write()


def ai_cost() -> None:
    b = Board("dawai-ai-cost", "3. AI and cost", "LLM spend, budget state, fallbacks, latency of every graph node.")
    b.stat(
        "Spend today (USD)",
        'budget_spend_usd{job="gateway"}',
        unit="currencyUSD",
        decimals=2,
    )
    b.stat(
        "Budget used",
        'budget_spend_ratio{job="gateway"} * 100',
        unit="percent",
        decimals=0,
        steps=[(None, GREEN), (70, YELLOW), (90, ORANGE), (100, RED)],
        desc="normal < 70% < economy < 90% < essential < 100% = exhausted.",
    )
    b.stat(
        "Budget state",
        'budget_state{job="gateway"}',
        steps=[(None, GREEN), (1, YELLOW), (2, ORANGE), (3, RED)],
        desc="0 normal, 1 economy, 2 essential, 3 exhausted.",
    )
    b.stat(
        "Fallback share (1h)",
        'sum(increase(llm_fallback_total{job="ai-service"}[1h])) / clamp_min(sum(increase(llm_calls_total{job="ai-service",status="ok"}[1h])), 1)',
        unit="percentunit",
        decimals=1,
        steps=[(None, GREEN), (0.05, YELLOW), (0.25, RED)],
    )
    b.stat(
        "LLM error rate (5m)",
        "dawai:llm_error_ratio:rate5m",
        unit="percentunit",
        decimals=1,
        steps=[(None, GREEN), (0.05, YELLOW), (0.1, RED)],
    )
    b.stat(
        "Circuit open",
        'sum(llm_circuit_open{job="ai-service"}) or vector(0)',
        steps=[(None, GREEN), (1, ORANGE)],
    )
    b.series(
        "Cost per hour by model (USD)",
        [('sum by (model) (increase(llm_cost_usd_total{job="ai-service"}[1h]))', "{{model}}")],
        unit="currencyUSD",
        stack=True,
    )
    b.series(
        "Cost by intent (USD, 1h)",
        [('sum by (intent) (increase(ai_cost_usd_total{job="gateway"}[1h]))', "{{intent}}")],
        unit="currencyUSD",
        stack=True,
    )
    b.series(
        "Tokens per minute by model",
        [('sum by (model, direction) (rate(llm_tokens_total{job="ai-service"}[5m])) * 60', "{{model}} {{direction}}")],
    )
    b.series(
        "LLM calls by provider and status (per min)",
        [('sum by (provider, status) (rate(llm_calls_total{job="ai-service"}[5m])) * 60', "{{provider}} {{status}}")],
    )
    b.heatmap(
        "Graph node latency",
        'sum by (le) (rate(graph_node_latency_ms_bucket{job="ai-service"}[5m]))',
        desc="All nodes together; use the table below for one node.",
    )
    b.series(
        "Node latency p95 by node (ms)",
        [('histogram_quantile(0.95, sum by (node, le) (rate(graph_node_latency_ms_bucket{job="ai-service"}[5m])))', "{{node}}")],
        unit="ms",
    )
    b.series(
        "Verifier failures by code (per hour)",
        [('sum by (code) (increase(verifier_failures_total{job="ai-service"}[1h]))', "{{code}}")],
        w=8,
    )
    b.heatmap(
        "Extraction confidence",
        'sum by (le) (rate(extraction_confidence_bucket{job="ai-service"}[30m]))',
        w=8,
    )
    b.series(
        "Requests degraded by the cost guard (per hour)",
        [('sum by (state, reason) (increase(budget_limited_total{job="ai-service"}[1h]))', "{{state}} {{reason}}")],
        w=8,
    )
    b.write()


def whatsapp() -> None:
    b = Board("dawai-whatsapp", "4. WhatsApp", "Sends, API errors, number quality and templates.")
    b.series(
        "Outbound by kind and outcome (per min)",
        [('sum by (kind, status) (rate(wa_outbound_total{job="gateway"}[5m])) * 60', "{{kind}} {{status}}")],
        stack=True,
    )
    b.series(
        "Template vs session messages (per min)",
        [
            ('sum(rate(wa_outbound_total{job="gateway",kind="template",status="sent"}[5m])) * 60', "template (outside the 24 h window)"),
            ('sum(rate(wa_outbound_total{job="gateway",kind=~"text|buttons|audio",status="sent"}[5m])) * 60', "session"),
        ],
    )
    b.series(
        "Meta API errors by code (per hour)",
        [('sum by (code) (increase(wa_api_errors_total{job="gateway"}[1h]))', "{{code}}")],
        desc="190 = token problem; 130429 / 131056 = rate limit; 131047 = outside the 24 h window.",
    )
    b.series(
        "Webhook responses (per min)",
        [('sum by (status) (rate(webhook_responses_total{job="gateway"}[5m])) * 60', "{{status}}")],
    )
    b.stat(
        "Number quality",
        'max(wa_quality_state{job="gateway",state=~"flagged|downgraded"}) or vector(0)',
        steps=[(None, GREEN), (1, RED)],
        desc="1 when Meta flagged the number or lowered its limit.",
    )
    b.stat(
        "Templates rejected (24h)",
        'sum(increase(wa_template_status_total{job="gateway",status=~"rejected|paused|disabled"}[1d])) or vector(0)',
        steps=[(None, GREEN), (1, RED)],
    )
    b.stat(
        "Block / opt-out signals (24h)",
        'sum(increase(wa_user_block_signals_total{job="gateway"}[1d])) or vector(0)',
        steps=[(None, GREEN), (3, YELLOW), (10, RED)],
        desc="Delivery failures 131026 / 131050: the person cannot or does not want to receive us.",
    )
    b.series(
        "Number and quality events (per day)",
        [('sum by (kind) (increase(wa_account_events_total{job="gateway"}[1d]))', "{{kind}}")],
        w=12,
        h=6,
    )
    b.write()


def reminders() -> None:
    b = Board("dawai-reminders", "5. Reminders and adherence", "Are reminders timely, and do people answer them?")
    b.series("Reminders sent (per hour)", [('sum(increase(reminders_sent_total{job="gateway"}[1h]))', "sent")])
    b.series(
        "Lag p95 (ms)",
        [('histogram_quantile(0.95, sum by (le) (rate(reminder_lag_ms_bucket{job="gateway"}[10m])))', "p95 lag")],
        unit="ms",
        lines=[(120000, YELLOW), (300000, RED)],
        desc="Scheduled time -> handed to the outbound queue. SLO: 99% within 2 min.",
    )
    b.series(
        "Outcomes (per hour)",
        [('sum by (status) (increase(reminder_ack_total{job="gateway"}[1h]))', "{{status}}")],
        stack=True,
    )
    b.stat(
        "Taken share (24h)",
        'sum(increase(reminder_ack_total{job="gateway",status="taken"}[1d])) / clamp_min(sum(increase(reminder_ack_total{job="gateway"}[1d])), 1)',
        unit="percentunit",
        decimals=0,
        steps=[(None, RED), (0.5, YELLOW), (0.75, GREEN)],
        desc="taken / (taken + skipped + missed). Aggregate only.",
    )
    b.stat(
        "Missed share (24h)",
        'sum(increase(reminder_ack_total{job="gateway",status="missed"}[1d])) / clamp_min(sum(increase(reminder_ack_total{job="gateway"}[1d])), 1)',
        unit="percentunit",
        decimals=0,
        steps=[(None, GREEN), (0.25, YELLOW), (0.5, RED)],
    )
    b.stat(
        "Caregiver alerts (24h)",
        'sum(increase(caregiver_alerts_total{job="gateway"}[1d])) or vector(0)',
    )
    b.write()


def safety() -> None:
    b = Board("dawai-safety", "6. Safety", "Emergencies, blocklists, injections and the cost guard's effect on safety.")
    b.series(
        "Emergencies detected by category and source (per hour)",
        [('sum by (category, source) (increase(emergency_detected_total{job="ai-service"}[1h]))', "{{category}} / {{source}}")],
        stack=True,
        desc="source = rules or classifier. The gateway's own keyword pre-check is counted by the span attribute dawai.emergency.",
    )
    b.series(
        "Emergency replies sent vs failed (per hour)",
        [('sum by (status) (increase(emergency_outbound_total{job="gateway"}[1h]))', "{{status}}")],
        desc="Any failed value pages.",
    )
    b.series(
        "Red-flag hits: verifier failures by code (per hour)",
        [('sum by (code) (increase(verifier_failures_total{job="ai-service"}[1h]))', "{{code}}")],
        desc="Diagnosis / advice / ungrounded wording blocked by the verifier blocklists.",
    )
    b.series(
        "Document values dropped as instructions (per hour)",
        [('sum by (reason) (increase(injection_dropped_total{job="ai-service"}[1h]))', "{{reason}}")],
        desc="Text on a document that read like an order to the assistant (prompt injection).",
    )
    b.series(
        "Out-of-scope share of replies",
        [
            (
                'sum(rate(reply_latency_ms_count{job="gateway",intent="out_of_scope"}[30m])) / clamp_min(sum(rate(reply_latency_ms_count{job="gateway"}[30m])), 1e-9)',
                "out_of_scope",
            )
        ],
        unit="percentunit",
    )
    b.series(
        "Cost guard: requests limited (per hour)",
        [('sum by (state, reason) (increase(budget_limited_total{job="ai-service"}[1h]))', "{{state}} {{reason}}")],
        desc="Emergencies are never limited: the rules and the emergency template do not read the budget.",
    )
    b.logs("Emergency events", '{service_name=~"gateway|ai-service"} |= "emergency_detected"')
    b.write()


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for build in (overview, queues, ai_cost, whatsapp, reminders, safety):
        build()
    print("wrote", len(list(OUT.glob("*.json"))), "dashboards to", OUT)
