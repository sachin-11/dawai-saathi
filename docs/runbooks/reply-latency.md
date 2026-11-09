# Runbook: Replies are slow (ReplySlow* alerts)

**Alerts:** ReplySlowDocumentsFastBurn, ReplySlowDocumentsSlowBurn, ReplySlowTextFastBurn, ReplySlowTextSlowBurn
**Dashboard:** [dawai-overview](http://localhost:3003/d/dawai-overview) (local Grafana, `make up-obs`)

## What it means

Too many replies take longer than the SLO allows: prescriptions and lab reports over 30 s, text over 10 s. The latency is measured from the moment WhatsApp delivered the message to the moment WhatsApp accepted our last reply.

## First checks

1. Open **Overview**: is it one intent (documents only) or all of them? Documents only usually means a slow vision model; all intents means queueing or the webhook.
2. Open **Queues**: is `queue wait p95` high for `inbound` or `outbound`? If yes go to [queue-wait](queue-wait.md).
3. Open **AI and cost**: look at `Node latency p95 by node`. A single slow node (`vision_extract_rx`, `composer`) names the culprit. Check `LLM calls by provider and status` and `Fallback share`: a provider that times out and falls back doubles the latency.
4. Is `Budget state` above 0? In economy / essential mode the cheaper model answers, which is usually faster, but `essential` and `exhausted` answer with a busy message.
5. Find one slow request: in Tempo search `service.name=gateway` with duration > 30 s. The trace shows the webhook, the queue wait, the AI call and every graph node. The Langfuse trace id is the span attribute `dawai.langfuse_trace_id`.

## Mitigation

- Provider slow or failing: lower `LLM_CALL_TIMEOUT_S` so the router falls back sooner, or switch `LLM_PRIMARY` and `LLM_FALLBACK` (env change and restart).
- Queue backlog: add gateway instances (workers) or raise worker concurrency. Do not raise `OUTBOUND_RATE_PER_SEC` above what Meta allows for the number.
- Large images: check `VISION_MAX_PX`; a flood of multi-page PDFs can be bounded with `LAB_MAX_PAGES`.

## Escalation

If the p95 stays above the limit for more than 1 hour after the mitigation, page the owner and post in the incident channel.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
