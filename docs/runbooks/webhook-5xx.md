# Runbook: Webhook returns 5xx (WebhookServerErrors)

**Alerts:** WebhookServerErrors
**Dashboard:** [dawai-overview](http://localhost:3003/d/dawai-overview) (local Grafana, `make up-obs`)

## What it means

More than 1% of Meta's webhook calls fail. Meta retries with backoff, so messages are delayed, not lost, as long as this is fixed within hours. The webhook returns 500 only when Postgres or Redis fails.

## First checks

1. `GET /health/ready`: which of db / redis / s3 / queues is failing?
2. Logs: `webhook processing failed; responding 500` carries only the error type (never driver messages).
3. Connection pool exhaustion: many parallel webhook bursts against a small Postgres.

## Mitigation

- Restore the failing dependency. Do not disable signature verification to 'make it work': a 401 is Meta's, not ours, and means the app secret is wrong.
- After recovery nothing needs replaying: Meta redelivers, and the `wa_message_id` unique key plus job id make that idempotent.

## Escalation

Page the owner if it lasts more than 15 minutes: Meta stops retrying after some time.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
