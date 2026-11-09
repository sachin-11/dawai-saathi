# Runbook: Reminders are late (ReminderLag*, ReminderLateBurn)

**Alerts:** ReminderLagHigh, ReminderLateFastBurn, ReminderLateSlowBurn
**Dashboard:** [dawai-reminders](http://localhost:3003/d/dawai-reminders) (local Grafana, `make up-obs`)

## What it means

Reminder messages are handed to the outbound queue more than 2 minutes after their time (SLO) or 5 minutes (page).

## First checks

1. **Reminders**: lag p95. **Queues**: the `reminders` queue depth and wait. A slot is a delayed BullMQ job; the planner job runs every 15 minutes and creates jobs for the next 36 hours.
2. Are workers running and is Redis healthy? Delayed jobs live in Redis; a Redis restart without persistence loses them, but the planner recreates the missing ones on its next run.
3. Many users at 08:00 / 21:00 produce a burst: check `outbound` wait.

## Mitigation

- Add workers. If Redis lost data, the next planner run (within 15 minutes) restores every slot in the horizon; slots more than 10 minutes late are marked missed silently and never sent late.

## Escalation

Page when the p95 lag is above 5 minutes for 5 minutes.

_Related: [SLOs](../slo.md), [all runbooks](README.md)._
