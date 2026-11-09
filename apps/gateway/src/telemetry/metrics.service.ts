import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * The only label names a collector may have (M15). Low-cardinality machine tokens: never a user id,
 * a drug name or a text. `metrics.service.spec.ts` fails when a collector uses anything else.
 */
export const METRIC_LABEL_ALLOWLIST: ReadonlySet<string> = new Set([
  'type',
  'kind',
  'status',
  'code',
  'queue',
  'reason',
  'intent',
  'scope',
  'state',
  'model',
  'le',
]);

const MS_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000];
const WAIT_BUCKETS = [10, 50, 250, 1000, 5000, 15_000, 30_000, 60_000, 300_000];
const REPLY_BUCKETS = [500, 1000, 2500, 5000, 10_000, 20_000, 30_000, 60_000, 120_000];
const BUDGET_STATES = { normal: 0, economy: 1, essential: 2, exhausted: 3 } as const;
export type BudgetStateName = keyof typeof BUDGET_STATES;

/** One Prometheus registry for the gateway: counters and histograms are updated inline, queue depth
 * and DLQ size by `QueueMetricsCollector`. Served at GET /metrics (token-protected). */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly waInbound = new Counter({
    name: 'wa_inbound_total',
    help: 'Inbound WhatsApp messages by type',
    labelNames: ['type'],
    registers: [this.registry],
  });
  readonly waOutbound = new Counter({
    name: 'wa_outbound_total',
    help: 'Outbound WhatsApp sends by kind and outcome',
    labelNames: ['kind', 'status'],
    registers: [this.registry],
  });
  readonly waApiErrors = new Counter({
    name: 'wa_api_errors_total',
    help: 'WhatsApp API errors by Meta error code',
    labelNames: ['code'],
    registers: [this.registry],
  });
  readonly emergencyOutbound = new Counter({
    name: 'emergency_outbound_total',
    help: 'Emergency replies (priority 1) by outcome',
    labelNames: ['status'],
    registers: [this.registry],
  });
  readonly webhookLatency = new Histogram({
    name: 'webhook_latency_ms',
    help: 'Time to answer a webhook POST',
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
    registers: [this.registry],
  });
  readonly webhookResponses = new Counter({
    name: 'webhook_responses_total',
    help: 'Webhook POST responses by HTTP status class',
    labelNames: ['status'],
    registers: [this.registry],
  });
  readonly queueDepth = new Gauge({
    name: 'queue_depth',
    help: 'Jobs waiting in a queue',
    labelNames: ['queue'],
    registers: [this.registry],
  });
  readonly queueWait = new Histogram({
    name: 'queue_wait_ms',
    help: 'Time a job waited before a worker took it',
    labelNames: ['queue'],
    buckets: WAIT_BUCKETS,
    registers: [this.registry],
  });
  readonly jobDuration = new Histogram({
    name: 'job_duration_ms',
    help: 'Time a worker spent on one job',
    labelNames: ['queue'],
    buckets: MS_BUCKETS,
    registers: [this.registry],
  });
  readonly jobFailed = new Counter({
    name: 'job_failed_total',
    help: 'Failed job attempts',
    labelNames: ['queue', 'reason'],
    registers: [this.registry],
  });
  readonly dlqSize = new Gauge({
    name: 'dlq_size',
    help: 'Jobs in the dead-letter queue',
    labelNames: ['queue'],
    registers: [this.registry],
  });
  readonly dlqMoved = new Counter({
    name: 'dlq_moved_total',
    help: 'Jobs moved to a dead-letter queue',
    labelNames: ['queue'],
    registers: [this.registry],
  });
  readonly replyLatency = new Histogram({
    name: 'reply_latency_ms',
    help: 'Inbound message received to final reply accepted by WhatsApp',
    labelNames: ['intent'],
    buckets: REPLY_BUCKETS,
    registers: [this.registry],
  });
  readonly remindersSent = new Counter({
    name: 'reminders_sent_total',
    help: 'Reminder messages handed to the outbound queue',
    registers: [this.registry],
  });
  readonly reminderLag = new Histogram({
    name: 'reminder_lag_ms',
    help: 'Scheduled time to reminder handed to the outbound queue',
    buckets: [1000, 5000, 15_000, 30_000, 60_000, 120_000, 300_000, 900_000],
    registers: [this.registry],
  });
  readonly reminderAck = new Counter({
    name: 'reminder_ack_total',
    help: 'Reminder outcomes by status',
    labelNames: ['status'],
    registers: [this.registry],
  });
  readonly caregiverAlerts = new Counter({
    name: 'caregiver_alerts_total',
    help: 'Caregiver missed-dose alerts sent',
    registers: [this.registry],
  });
  readonly rateLimited = new Counter({
    name: 'rate_limited_total',
    help: 'Messages stopped by a rate limit',
    labelNames: ['scope'],
    registers: [this.registry],
  });
  readonly userBlocked = new Counter({
    name: 'user_blocked_total',
    help: 'Users blocked automatically',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  readonly budgetState = new Gauge({
    name: 'budget_state',
    help: 'Daily LLM budget state (0 normal, 1 economy, 2 essential, 3 exhausted)',
    registers: [this.registry],
  });
  readonly budgetSpendRatio = new Gauge({
    name: 'budget_spend_ratio',
    help: 'Today LLM spend divided by LLM_DAILY_BUDGET_USD',
    registers: [this.registry],
  });
  readonly budgetSpendUsd = new Gauge({
    name: 'budget_spend_usd',
    help: 'Today LLM spend in USD (Asia/Kolkata day)',
    registers: [this.registry],
  });
  readonly aiCostUsd = new Counter({
    name: 'ai_cost_usd_total',
    help: 'LLM spend reported by the AI service, by intent',
    labelNames: ['intent'],
    registers: [this.registry],
  });
  readonly aiCalls = new Counter({
    name: 'ai_calls_total',
    help: 'Calls to the AI service by outcome',
    labelNames: ['status'],
    registers: [this.registry],
  });
  readonly waQualityState = new Gauge({
    name: 'wa_quality_state',
    help: 'WhatsApp number quality (1 for the current state label)',
    labelNames: ['state'],
    registers: [this.registry],
  });
  readonly waAccountEvents = new Counter({
    name: 'wa_account_events_total',
    help: 'WhatsApp account / quality / limit events',
    labelNames: ['kind'],
    registers: [this.registry],
  });
  readonly waTemplateStatus = new Counter({
    name: 'wa_template_status_total',
    help: 'Template status changes reported by Meta',
    labelNames: ['status'],
    registers: [this.registry],
  });
  readonly waUserBlockSignals = new Counter({
    name: 'wa_user_block_signals_total',
    help: 'Delivery failures that look like a user blocking or opting out',
    labelNames: ['code'],
    registers: [this.registry],
  });

  constructor() {
    // A counter that first appears with a non-zero value makes `increase()` return 0 for that first
    // event, so an alert on "any failure" would stay silent exactly once. The series the alerts watch
    // therefore exist at 0 from the first scrape.
    this.waApiErrors.inc({ code: '190' }, 0);
    this.emergencyOutbound.inc({ status: 'failed' }, 0);
    this.emergencyOutbound.inc({ status: 'sent' }, 0);
    for (const queue of ['inbound', 'outbound', 'reminders', 'user-deletion']) {
      this.dlqMoved.inc({ queue }, 0);
    }
    for (const status of ['rejected', 'paused', 'disabled']) {
      this.waTemplateStatus.inc({ status }, 0);
    }
  }

  setBudgetState(state: BudgetStateName): void {
    this.budgetState.set(BUDGET_STATES[state]);
  }

  setQuality(state: string): void {
    this.waQualityState.reset();
    this.waQualityState.labels(state).set(1);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
