# Runbook: Dead-letter queue is not empty (DeadLetterQueueNotEmpty, InboundUnserved*)

**Alerts:** DeadLetterQueueNotEmpty, InboundUnservedFastBurn, InboundUnservedSlowBurn
**Dashboard:** [dawai-queues](http://localhost:3003/d/dawai-queues) (local Grafana, `make up-obs`)

## What it means

A job ran out of attempts and was moved to `<queue>-dlq`. For `inbound` the user has already received one 'something went wrong, please try again' message (exactly once). Nothing is lost silently, but the user's request was not served.

## First checks

1. List what is in the queue: `pnpm --filter @dawai/gateway cli dlq:list --queue inbound`. Each entry has the error class or Meta code, attempts, trace id and the user/message uuids. It never has the message text.
2. Open the trace in Tempo with the `traceId` from the entry; the failing span shows where it broke (AI service, S3 download, database).
3. Group the entries by `errorCode`: one code for all of them means a dependency outage; many different codes means a bug.
4. `outbound` entries with a WhatsApp error code: see [whatsapp-token](whatsapp-token.md) for 190 and [whatsapp-quality](whatsapp-quality.md) for 131xxx codes.

## Mitigation

- Dependency was down and is back: `pnpm --filter @dawai/gateway cli dlq:retry --queue inbound` puts the original failed jobs back. The user may get the answer a second time later; that is better than silence.
- Poison message (always fails): leave it, note the trace id in the ticket, then `dlq:purge --queue inbound` after the bug is filed. Every retry and purge is written to `audit_logs` (actor `admin`).

## Escalation

Page when `InboundUnservedFastBurn` fires: more than 7% of inbound messages are being dead-lettered.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
