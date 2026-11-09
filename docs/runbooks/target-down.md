# Runbook: Prometheus cannot scrape a service (TargetDown)

**Alerts:** TargetDown
**Dashboard:** [dawai-overview](http://localhost:3003/d/dawai-overview) (local Grafana, `make up-obs`)

## What it means

`up == 0` for the gateway or the AI service for 2 minutes: the process is down, unreachable, or `/metrics` answers 401.

## First checks

1. `GET /health/live` on the service. If that works, the token is wrong: `/metrics` needs `Authorization: Bearer <METRICS_TOKEN>` and the same value must be in Prometheus's `metrics_token` file.
2. Is the container restarting? `GET /health/startup` returns 503 until the models are loaded (AI service: the spaCy model).

## Mitigation

- Restart the service or fix the token; no data is lost, metrics simply have a gap.

## Escalation

If the service itself is down, this is also an outage: follow the alert for the symptom (webhook 5xx, queue wait).

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
