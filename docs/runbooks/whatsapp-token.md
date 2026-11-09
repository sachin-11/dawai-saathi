# Runbook: WhatsApp access token rejected (WhatsAppTokenError)

**Alerts:** WhatsAppTokenError
**Dashboard:** [dawai-whatsapp](http://localhost:3003/d/dawai-whatsapp) (local Grafana, `make up-obs`)

## What it means

Meta answered error code 190: the access token is expired or revoked. Every send fails, including emergency replies, until a valid token is in place.

## First checks

1. **WhatsApp** dashboard: `Meta API errors by code` with 190, and `Outbound by kind and outcome` failing.
2. In Meta Business settings check whether the system-user token was revoked or the app lost permissions.

## Mitigation

- Create a new permanent system-user token with `whatsapp_business_messaging`, store it as `WA_ACCESS_TOKEN` (Secrets Manager), restart the gateway.
- Failed outbound jobs retry on their own; those that ran out of attempts are in `outbound-dlq`: `cli dlq:retry --queue outbound`.

## Escalation

Page immediately: users cannot receive anything, including a 112 message.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
