/** Shapes returned by the gateway's `/admin/*` API (see apps/gateway/src/admin). No phone numbers, ever. */
export interface AdminStats {
  range: '7d' | '30d' | '90d';
  users: { total: number; new: number; active7d: number };
  documentsByDay: { day: string; kind: string; n: number }[];
  averageConfidence: number | null;
  needsReview: number;
  reminders: { taken: number; missed: number; skipped: number; ackRate: number | null };
  emergenciesByCategory: { category: string; n: number }[];
  costByDay: { day: string; usd: number; demoUsd: number }[];
  budget: {
    state: 'normal' | 'economy' | 'essential' | 'exhausted';
    spentUsd: number;
    ratio: number;
    demoExhausted: boolean;
    demoSpentUsd: number;
  };
}

export interface ReviewItem {
  id: string;
  userId: string;
  kind: string;
  status: string;
  createdAt: string;
  confidence: number | null;
  promptVersion: string | null;
  model: string | null;
  warnings: { lowConfidenceItems: number; critical: boolean };
  reviewLabel: string | null;
  reviewedAt: string | null;
}
export interface ReviewQueuePage {
  items: ReviewItem[];
  nextCursor: string | null;
}

export const REVIEW_LABELS = [
  'correct',
  'extraction_wrong',
  'unreadable',
  'not_a_document',
] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

export interface EvalRun {
  suite: string;
  mode: string;
  cases: number;
  passed: boolean;
  hardGates: { metric: string; rule: string; value: number; passed: boolean }[];
  softRegressions: number;
  costUsd: number;
  latencyP95Ms: number;
  models: Record<string, string>;
  softMetrics: { metric: string; value: number; status: string }[];
}
export interface EvalReport {
  file: string;
  date: string;
  sha: string;
  scope: string;
  passed: boolean;
  runs: EvalRun[];
}
export interface PromptInfo {
  id: string;
  family: string;
  version: number;
  file: string;
  current: boolean;
}
export interface DlqOverview {
  queues: { queue: string; size: number; entries: DlqEntry[] }[];
}
export interface DlqEntry {
  sourceJobId: string;
  dlqJobId?: string;
  errorCode?: string;
  attempts?: number;
  traceId?: string;
  failedAt?: string;
  [key: string]: unknown;
}
