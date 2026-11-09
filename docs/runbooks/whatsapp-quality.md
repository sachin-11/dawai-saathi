# Runbook: WhatsApp number quality or templates (WhatsAppQualityDropped, WhatsAppTemplateRejected, WhatsAppUserBlockSignals)

**Alerts:** WhatsAppQualityDropped, WhatsAppTemplateRejected, WhatsAppUserBlockSignals
**Dashboard:** [dawai-whatsapp](http://localhost:3003/d/dawai-whatsapp) (local Grafana, `make up-obs`)

## What it means

Meta reported a lower quality rating or messaging-limit tier for our number, rejected or paused a template, or several recipients blocked us. A low rating can end with the number being restricted, which would stop reminders and caregiver alerts.

## First checks

1. Look at the `whatsapp_account_event` log lines (event token, tier, template name) and the **WhatsApp** dashboard.
2. In WhatsApp Manager open Account quality and the template list; read Meta's reason for a rejection.
3. Which reminders go to people who never answer? **Reminders** dashboard: the missed share. Many missed doses mean many unwanted messages.

## Mitigation

- Reduce proactive messages first: pause `DAILY_SUMMARY_ENABLED`, lengthen reminder intervals, stop reminders for users with a long run of misses (they can say START REMINDERS).
- Rewrite a rejected template (`docs/whatsapp-templates.md`) so it is clearly a transactional reminder and resubmit; keep wording free of medical claims.
- Never send to people who did not opt in: every user consented, every caregiver replied YES.

## Escalation

If the rating is RED / flagged, stop all proactive sends and tell the owner the same day.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
