# Runbook: A user erasure (DELETE) is stuck (UserErasureDeadLetter)

**Alerts:** UserErasureDeadLetter
**Dashboard:** [dawai-queues](http://localhost:3003/d/dawai-queues) (local Grafana, `make up-obs`)

## What it means

A `user-deletion` job failed all its attempts. The DPDP Act requires erasure on request, so this is a high-priority incident even though one user is affected. Until it is fixed, that user's data still exists.

## First checks

1. `pnpm --filter @dawai/gateway cli dlq:list --queue user-deletion` shows the job id and the error code (S3 unreachable? database lock? Redis?).
2. Check S3 and Postgres readiness: `GET /health/ready` on the gateway.
3. The user's row has `deleted_at` set (an in-flight marker). The router ignores that user for 15 minutes at a time; they receive no messages meanwhile.

## Mitigation

- Fix the dependency, then `pnpm --filter @dawai/gateway cli dlq:retry --queue user-deletion`. The erasure steps are idempotent and re-runnable.
- Confirm: no rows for that user id in any table, the S3 prefix `media/<userId>/` is empty, and exactly one anonymous `user_deleted` audit row exists.
- Failed deletion jobs are kept for 7 days (they hold the user's phone number, encrypted, so the final message can be sent). Do not purge before the erasure succeeded.

## Escalation

Page immediately; tell the owner the moment it is resolved so it can be documented for compliance.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
