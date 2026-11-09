# Runbook: Jobs wait too long in a queue (QueueWaitHigh)

**Alerts:** QueueWaitHigh
**Dashboard:** [dawai-queues](http://localhost:3003/d/dawai-queues) (local Grafana, `make up-obs`)

## What it means

Jobs sit in `inbound` or `outbound` for more than 60 s (p95) before a worker starts them: not enough workers, workers stuck, or Redis trouble.

## First checks

1. **Queues** dashboard: depth and wait per queue. Depth rising and job duration flat means too few workers; job duration rising means the work itself got slow (see [reply-latency](reply-latency.md)).
2. Are workers running? `WORKERS_ENABLED=false` on every instance means nobody consumes. Look for `worker error` log lines.
3. Redis: `GET /health/ready` and Redis CPU / memory. A restarted Redis without persistence loses queued jobs; Meta redelivers webhooks, so inbound recovers.
4. `outbound` only: the limiter `OUTBOUND_RATE_PER_SEC` or Meta rate limits (error 130429 / 131056, jobs back off 30 s x attempt).

## Mitigation

- Start more gateway instances (workers share the queue). Concurrency is 5 for inbound and outbound.
- Restart a stuck worker instance: SIGTERM lets jobs in flight finish for `SHUTDOWN_GRACE_S`, the rest are retried by others.

## Escalation

If the backlog keeps growing after doubling the instances, escalate to the owner.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
