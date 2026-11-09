# Runbooks

One per alert (`infra/observability/alerts.yml` points at them with `runbook_url`).

| Runbook | Alerts |
|---|---|
| [Replies are slow (ReplySlow* alerts)](reply-latency.md) | ReplySlowDocumentsFastBurn, ReplySlowDocumentsSlowBurn, ReplySlowTextFastBurn, ReplySlowTextSlowBurn |
| [Dead-letter queue is not empty (DeadLetterQueueNotEmpty, InboundUnserved*)](dlq-not-empty.md) | DeadLetterQueueNotEmpty, InboundUnservedFastBurn, InboundUnservedSlowBurn |
| [A user erasure (DELETE) is stuck (UserErasureDeadLetter)](user-erasure-stuck.md) | UserErasureDeadLetter |
| [Jobs wait too long in a queue (QueueWaitHigh)](queue-wait.md) | QueueWaitHigh |
| [Webhook returns 5xx (WebhookServerErrors)](webhook-5xx.md) | WebhookServerErrors |
| [LLM provider errors or circuit open (LlmErrorRateHigh, AllLlmProvidersDown)](llm-errors.md) | LlmErrorRateHigh, AllLlmProvidersDown |
| [WhatsApp access token rejected (WhatsAppTokenError)](whatsapp-token.md) | WhatsAppTokenError |
| [Daily LLM budget is running out (LlmBudgetBurn80)](llm-budget.md) | LlmBudgetBurn80 |
| [Emergency reply failed to send (EmergencyReplyFailing)](emergency-reply-failing.md) | EmergencyReplyFailing |
| [Reminders are late (ReminderLag*, ReminderLateBurn)](reminder-lag.md) | ReminderLagHigh, ReminderLateFastBurn, ReminderLateSlowBurn |
| [WhatsApp number quality or templates (WhatsAppQualityDropped, WhatsAppTemplateRejected, WhatsAppUserBlockSignals)](whatsapp-quality.md) | WhatsAppQualityDropped, WhatsAppTemplateRejected, WhatsAppUserBlockSignals |
| [Prometheus cannot scrape a service (TargetDown)](target-down.md) | TargetDown |

Operator commands used in these runbooks:

```
pnpm --filter @dawai/gateway cli dlq:list   --queue <inbound|outbound|reminders|user-deletion>
pnpm --filter @dawai/gateway cli dlq:retry  --queue <queue> [--job <id>]
pnpm --filter @dawai/gateway cli dlq:purge  --queue <queue>
pnpm --filter @dawai/gateway cli user:unblock --user <uuid>
```

Every retry, purge and unblock writes an `audit_logs` row (actor `admin`).
