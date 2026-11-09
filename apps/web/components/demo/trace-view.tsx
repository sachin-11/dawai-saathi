'use client';

import { useTranslations } from 'next-intl';

import { GraphDiagram } from '@/components/graph-diagram';
import { Badge } from '@/components/ui/badge';
import type { TraceEntry } from '@/lib/demo-types';

export function summariseTrace(trace: readonly TraceEntry[]): {
  totalLatencyMs: number;
  totalCostUsd: number;
  maxLatencyMs: number;
  visited: Set<string>;
  verifier: 'ok' | 'fallback' | 'skipped';
} {
  const visited = new Set(trace.map((entry) => entry.node));
  const verifierRan = visited.has('verifier');
  return {
    totalLatencyMs: trace.reduce((sum, entry) => sum + entry.latency_ms, 0),
    totalCostUsd: trace.reduce((sum, entry) => sum + (entry.cost_usd ?? 0), 0),
    maxLatencyMs: Math.max(1, ...trace.map((entry) => entry.latency_ms)),
    visited,
    verifier: !verifierRan ? 'skipped' : visited.has('rx_fallback') ? 'fallback' : 'ok',
  };
}

const STATUS_TONE = { ok: 'ok', error: 'danger', timeout: 'danger', fallback: 'warn' } as const;

function formatUsd(value: number): string {
  return value === 0 ? '$0' : value < 0.001 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`;
}

export function TraceView({ trace }: { trace: readonly TraceEntry[] | null | undefined }) {
  const t = useTranslations('demo.trace');
  if (!trace || trace.length === 0) return <p className="text-muted">{t('none')}</p>;
  const summary = summariseTrace(trace);
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-surface-2 p-3">
          <dt className="text-xs text-muted">{t('totalLatency')}</dt>
          <dd className="text-lg font-bold tabular-nums">
            {(summary.totalLatencyMs / 1000).toFixed(2)} s
          </dd>
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <dt className="text-xs text-muted">{t('totalCost')}</dt>
          <dd className="text-lg font-bold tabular-nums">{formatUsd(summary.totalCostUsd)}</dd>
        </div>
        <div className="col-span-2 rounded-xl bg-surface-2 p-3 sm:col-span-1">
          <dt className="text-xs text-muted">{t('verifier')}</dt>
          <dd className="text-sm font-semibold">
            {summary.verifier === 'ok'
              ? t('verifierOk')
              : summary.verifier === 'fallback'
                ? t('verifierFallback')
                : t('verifierSkipped')}
          </dd>
        </div>
      </dl>

      <ol className="space-y-2" aria-label={t('title')}>
        {trace.map((entry, index) => (
          <li
            key={`${entry.node}-${index}`}
            data-testid="trace-row"
            className="rounded-xl border border-border bg-surface p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm font-semibold">{entry.node}</span>
              <span className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[entry.status]}>{t(`status.${entry.status}`)}</Badge>
                <span className="text-sm tabular-nums">{entry.latency_ms} ms</span>
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="presentation">
              <div
                data-testid="latency-bar"
                className="h-full rounded-full bg-primary"
                style={{
                  width: `${Math.max(2, (entry.latency_ms / summary.maxLatencyMs) * 100)}%`,
                }}
              />
            </div>
            {(entry.model || entry.prompt_version || entry.cost_usd || entry.tokens_in) && (
              <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                {entry.model && (
                  <div>
                    <dt className="inline">{t('model')}: </dt>
                    <dd className="inline font-mono">{entry.model}</dd>
                  </div>
                )}
                {entry.prompt_version && (
                  <div>
                    <dt className="inline">{t('prompt')}: </dt>
                    <dd className="inline font-mono">{entry.prompt_version}</dd>
                  </div>
                )}
                {(entry.tokens_in != null || entry.tokens_out != null) && (
                  <div>
                    <dt className="inline">{t('tokens')}: </dt>
                    <dd className="inline tabular-nums">
                      {entry.tokens_in ?? 0} / {entry.tokens_out ?? 0}
                    </dd>
                  </div>
                )}
                {entry.cost_usd != null && entry.cost_usd > 0 && (
                  <div>
                    <dt className="inline">{t('cost')}: </dt>
                    <dd className="inline tabular-nums">{formatUsd(entry.cost_usd)}</dd>
                  </div>
                )}
              </dl>
            )}
          </li>
        ))}
      </ol>

      <div>
        <h3 className="mb-2 font-semibold">{t('graphTitle')}</h3>
        <GraphDiagram
          visited={summary.visited}
          label={t('graphTitle')}
          visitedLabel={t('visited')}
          notVisitedLabel={t('notVisited')}
        />
      </div>
    </div>
  );
}
