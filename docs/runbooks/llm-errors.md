# Runbook: LLM provider errors or circuit open (LlmErrorRateHigh, AllLlmProvidersDown)

**Alerts:** LlmErrorRateHigh, AllLlmProvidersDown
**Dashboard:** [dawai-ai-cost](http://localhost:3003/d/dawai-ai-cost) (local Grafana, `make up-obs`)

## What it means

More than 10% of model calls fail, or every provider's circuit breaker is open (5 failures, 60 s cool-down). What still works with no model: the emergency RULES and templates, commands, the drug catalog, reminders. What stops: reading documents and answering questions.

## First checks

1. **AI and cost**: `LLM calls by provider and status` shows which provider and which kind (`timeout`, `rate_limit`, `auth`, `server`).
2. `auth`: the API key was rotated or revoked. `rate_limit`: the account's quota. `server`/`timeout`: the provider's outage; check its status page.
3. `GET /health/ready` on the AI service shows `llm_circuits`: closed / partial / open. Partial means one provider is out and fallback works.

## Mitigation

- One provider out: nothing to do, the fallback answers; watch cost (the fallback has its own prices).
- Both out: users get the generic 'please try again' reply, the gateway retries the job. Consider announcing a delay; the budget guard is not involved.
- Wrong key: replace it in Secrets Manager / `.env` and restart the AI service; the breaker closes after one successful probe.

## Escalation

Page for AllLlmProvidersDown lasting more than 10 minutes.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
