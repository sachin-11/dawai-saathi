# Runbook: Emergency reply failed to send (EmergencyReplyFailing)

**Alerts:** EmergencyReplyFailing
**Dashboard:** [dawai-safety](http://localhost:3003/d/dawai-safety) (local Grafana, `make up-obs`)

## What it means

An outbound job with priority 1 (the 112 / 108 message) failed. This is the most important message the service sends.

## First checks

1. **Safety** dashboard: `Emergency replies sent vs failed`. **WhatsApp**: API errors by code.
2. Common causes: expired token (190, see [whatsapp-token](whatsapp-token.md)), the 24 h window (131047: the emergency text is free-form), a deleted user.

## Mitigation

- Fix the cause; `cli dlq:list --queue outbound` and `dlq:retry --queue outbound`. Retried emergency messages keep priority 1.
- If the user can be reached another way, the owner decides; the service never calls anyone.

## Escalation

Page at once and keep the incident open until a test emergency message goes through end to end.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
