import { DlqRetryButton } from '@/components/admin/dlq-retry';
import { ErrorNote, PageHeader } from '@/components/admin/ui';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { AdminStats, DlqOverview } from '@/lib/admin-types';
import { adminFetch, currentAdmin } from '@/lib/gateway';
import { serverEnv } from '@/lib/server-env';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Operations' };

export default async function OperationsPage() {
  const email = (await currentAdmin()) ?? '';
  const env = serverEnv();
  const [stats, dlq] = await Promise.all([
    adminFetch<AdminStats>(email, '/stats?range=7d'),
    adminFetch<DlqOverview>(email, '/dlq'),
  ]);
  const links = [
    ['Grafana dashboards', env.GRAFANA_URL],
    ['Langfuse traces', env.LANGFUSE_URL],
  ] as const;

  return (
    <>
      <PageHeader title="Operations" />

      <Card className="space-y-3">
        <h2 className="font-bold">Budget</h2>
        {stats.ok ? (
          <p className="flex flex-wrap items-center gap-3">
            <Badge
              tone={
                stats.data.budget.state === 'normal'
                  ? 'ok'
                  : stats.data.budget.state === 'economy'
                    ? 'warn'
                    : 'danger'
              }
              className="text-base"
            >
              {stats.data.budget.state}
            </Badge>
            <span className="tabular-nums">
              ${stats.data.budget.spentUsd.toFixed(2)} today (
              {Math.round(stats.data.budget.ratio * 100)}%)
            </span>
            <span className="text-sm text-muted">
              Web demo: ${stats.data.budget.demoSpentUsd.toFixed(2)}{' '}
              {stats.data.budget.demoExhausted ? '(uploads off)' : ''}
            </span>
          </p>
        ) : (
          <ErrorNote result={stats} />
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-bold">Dead-letter queues</h2>
        {!dlq.ok ? (
          <ErrorNote result={dlq} />
        ) : (
          <ul className="space-y-4">
            {dlq.data.queues.map((queue) => (
              <li key={queue.queue}>
                <p className="font-semibold">
                  {queue.queue}{' '}
                  <Badge tone={queue.size === 0 ? 'ok' : 'danger'}>
                    {queue.size === 0 ? 'empty' : `${queue.size} waiting`}
                  </Badge>
                </p>
                {queue.entries.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {queue.entries.map((entry) => (
                      <li
                        key={`${entry.sourceJobId}-${entry.dlqJobId ?? ''}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 p-3 text-sm"
                      >
                        <span className="min-w-0">
                          <span className="font-mono text-xs break-all">{entry.sourceJobId}</span>
                          <span className="block text-xs text-muted">
                            {entry.errorCode ?? 'error'} · {entry.attempts ?? '?'} attempts
                            {entry.traceId ? ` · trace ${entry.traceId.slice(0, 8)}` : ''}
                          </span>
                        </span>
                        <DlqRetryButton queue={queue.queue} jobId={entry.sourceJobId} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-2">
        <h2 className="font-bold">Dashboards</h2>
        <ul className="list-disc pl-5">
          {links.map(([label, url]) => (
            <li key={label}>
              {url ? (
                <a className="underline" href={url} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              ) : (
                <span className="text-muted">{label}: not configured</span>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
