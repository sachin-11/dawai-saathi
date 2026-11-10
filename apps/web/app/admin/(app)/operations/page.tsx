import { Activity, ExternalLink, Inbox, LineChart, Wallet } from 'lucide-react';

import { DlqRetryButton } from '@/components/admin/dlq-retry';
import { ErrorNote, PageHeader, Panel } from '@/components/admin/ui';
import { Badge } from '@/components/ui/badge';
import type { AdminStats, DlqOverview } from '@/lib/admin-types';
import { adminFetch, currentAdmin } from '@/lib/gateway';
import { serverEnv } from '@/lib/server-env';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Operations' };

/** Is the tool answering? A 1.5 s server-side check, so the page can say "not running" instead of a dead link. */
async function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

export default async function OperationsPage() {
  const email = (await currentAdmin()) ?? '';
  const env = serverEnv();
  const [stats, dlq] = await Promise.all([
    adminFetch<AdminStats>(email, '/stats?range=7d'),
    adminFetch<DlqOverview>(email, '/dlq'),
  ]);
  const [grafanaUp, langfuseUp] = await Promise.all([
    reachable(env.GRAFANA_URL),
    reachable(env.LANGFUSE_URL),
  ]);
  const links = [
    {
      label: 'Grafana dashboards',
      detail: 'Latency, queues, cost and SLO burn rates',
      url: env.GRAFANA_URL,
      up: grafanaUp,
      icon: LineChart,
    },
    {
      label: 'Langfuse traces',
      detail: 'One trace per AI request, node by node',
      url: env.LANGFUSE_URL,
      up: langfuseUp,
      icon: Activity,
    },
  ];

  return (
    <>
      <PageHeader
        title="Operations"
        description="Spend guard, dead-letter queues and the monitoring tools."
      />

      <Panel title="Budget" icon={Wallet}>
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
      </Panel>

      <Panel title="Dead-letter queues" icon={Inbox}>
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
      </Panel>

      <Panel title="Dashboards">
        <ul className="grid gap-3 sm:grid-cols-2">
          {links.map(({ label, detail, url, up, icon: Icon }) => (
            <li key={label}>
              {url && up ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex h-full items-start gap-3 rounded-xl border border-border p-4 transition-colors hover:bg-surface-2"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-semibold">
                      {label}
                      <ExternalLink className="size-3.5 text-muted" aria-hidden />
                    </span>
                    <span className="block text-sm text-muted">{detail}</span>
                    <Badge tone="ok" className="mt-2">
                      Running
                    </Badge>
                  </span>
                </a>
              ) : (
                <div className="flex h-full items-start gap-3 rounded-xl border border-dashed border-border p-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{label}</span>
                    <span className="block text-sm text-muted">{detail}</span>
                    <Badge tone="warn" className="mt-2">
                      {url ? 'Not running' : 'Not configured'}
                    </Badge>
                    <span className="mt-1 block text-xs text-muted">
                      {url ? (
                        <>
                          Start it with <code className="font-mono">make up-obs</code>.
                        </>
                      ) : (
                        'Set the URL in the web app environment.'
                      )}
                    </span>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
