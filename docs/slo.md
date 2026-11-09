# Service level objectives (M15)

Three promises to users, measured monthly, alerted with multi-window burn rates. The rules are plain
PromQL in [`infra/observability/alerts.yml`](../infra/observability/alerts.yml) so M17 can translate them to
CloudWatch metric math. Every alert has a runbook in [`docs/runbooks/`](runbooks/README.md).

## Why these three

| # | Objective | Why this one |
|---|-----------|--------------|
| 1 | **95%** of prescription / lab-report replies within **30 s**; **99%** of text replies within **10 s** | The promise in the first message is "20-30 seconds" for a photo. A person standing at a pharmacy counter waits for this, and a patient with a question about a dose waits for the text answer. Two targets because a vision call and a text call have different physics. |
| 2 | **99.5%** of inbound messages are **served**: none dead-lettered, none silently dropped | The worst failure of a health assistant is silence. Meta retries the webhook, the queue retries the job, and a job that still fails lands in a dead-letter queue and the user is told once to try again. A message in a DLQ counts as *not served*, even though the user got an apology. |
| 3 | **99%** of reminders are handed to the outbound queue within **2 minutes** of their time | A dose reminder that arrives half an hour late is worse than none for someone who then takes a double dose. |

What we deliberately did **not** choose: availability of `/health/ready` (a healthy process can still serve nobody),
and p99 latency (too noisy at our volume; the objective above already bounds the tail).

## How each is measured

| SLI | Source (metric) | Bad event |
|-----|-----------------|-----------|
| Reply latency | `reply_latency_ms{intent}`: from the WhatsApp timestamp of the user's message to the moment WhatsApp accepted our final reply (set in the outbound worker, so queue wait, AI time and send time are all inside) | a reply slower than 30 s (`intent` prescription / lab_report) or 10 s (all others) |
| Served | `dlq_moved_total{queue="inbound"}` over `wa_inbound_total` | an inbound job that exhausted its attempts |
| Reminder timeliness | `reminder_lag_ms`: scheduled time to the moment the reminder was handed to the outbound queue | a lag over 120 s |

The reply latency of commands that never reach the AI service (HELP, MEDS) is not recorded: the label is set only
on answers that came from the AI service, so the text SLO reflects model-backed answers.

## Alerts: burn rate

Burn rate = observed bad ratio / allowed bad ratio. A burn rate of 1 spends the monthly budget exactly in a month.

| Alert pair | Windows | Fires when | Meaning |
|------------|---------|-----------|---------|
| `*FastBurn` (page) | 1 h **and** 5 m | burn >= 14.4 | the whole monthly budget would be gone in about 2 days |
| `*SlowBurn` (ticket) | 6 h **and** 30 m | burn >= 6 | the budget would be gone in about 5 days |

Using two windows means the long one proves the problem is real and the short one proves it is still happening, so an alert
stops soon after a fix instead of lingering for an hour. Thresholds per objective:

| Objective | Allowed bad | Fast burn pages at | Slow burn tickets at |
|-----------|-------------|--------------------|----------------------|
| documents within 30 s | 5% | 72% slow | 30% slow |
| text within 10 s | 1% | 14.4% slow | 6% slow |
| served | 0.5% | 7.2% dead-lettered | 3% dead-lettered |
| reminders within 2 min | 1% | 14.4% late | 6% late |

Because the product is small, a single slow reply can look like a large percentage in a quiet hour. The rules therefore
require both windows, and the pages are for ratios that no single event can reach at normal volume. If the volume is
under about 50 replies per hour, read the burn alerts together with the absolute counts on the Overview dashboard.

## Plain threshold alerts

`WebhookServerErrors` (5xx > 1% for 5 min), `QueueWaitHigh` (p95 > 60 s), `DeadLetterQueueNotEmpty` (10 min),
`UserErasureDeadLetter` (immediately: erasure is a legal duty), `LlmErrorRateHigh` (> 10%), `AllLlmProvidersDown`,
`WhatsAppTokenError` (Meta error 190), `LlmBudgetBurn80`, `EmergencyReplyFailing` (any failure), `ReminderLagHigh` (p95 > 5 min),
`WhatsAppQualityDropped`, `WhatsAppTemplateRejected`, `WhatsAppUserBlockSignals`, `TargetDown`.

## Routing

Alertmanager groups by alert name. `severity=page` and `priority=high` (erasure, emergency replies) repeat every 15 minutes.
Locally every alert is printed by the `alert-sink` container; in production (M17) the receiver becomes email / Slack / SNS and the
routing tree stays.
