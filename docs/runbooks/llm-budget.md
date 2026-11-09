# Runbook: Daily LLM budget is running out (LlmBudgetBurn80)

**Alerts:** LlmBudgetBurn80
**Dashboard:** [dawai-ai-cost](http://localhost:3003/d/dawai-ai-cost) (local Grafana, `make up-obs`)

## What it means

More than 80% of `LLM_DAILY_BUDGET_USD` is spent for today (Asia/Kolkata day). States: normal below 70%, economy 70-90% (cheap model for text calls, no spoken replies), essential 90-100% (only prescription reading, the emergency classifier and templates; lab reports and voice get 'busy'), exhausted 100% (templates and the emergency rules only). Emergencies are answered in every state.

## First checks

1. **AI and cost**: `Cost per hour by model` and `Cost by intent`. A sudden jump in one intent (lab reports, voice) or one model points at the cause.
2. The daily report job (23:55 IST) logs `daily_cost_report` with spend by model and intent and per active user. Look at yesterday's for a baseline.
3. One user draining the budget? `USER_DAILY_COST_USD` stops that: look for `rate_limit.cost_user` replies and `rate_limited_total`.
4. Abuse: many `user_blocked_total{reason}` or a flood of document uploads. Rate limits: `RL_DOCS_PER_DAY`.

## Mitigation

- Real growth: raise `LLM_DAILY_BUDGET_USD` (env change, restart). The state recomputes from the Redis counter, nothing else to do.
- Abuse: block the user: the abuse guard does it automatically; manual unblock `cli user:unblock --user <uuid>`.
- Bug (a loop calling the model): fix it and note that the counter keeps the real spend for the day.

## Escalation

If the budget is exhausted before the end of the day tell the owner: new documents get 'service busy' until local midnight.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
