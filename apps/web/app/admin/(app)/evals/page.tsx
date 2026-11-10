import { ErrorNote, PageHeader } from '@/components/admin/ui';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { EvalReport, EvalRun } from '@/lib/admin-types';
import { adminFetch, currentAdmin } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Evals' };

interface LatestRun {
  run: EvalRun;
  date: string;
  sha: string;
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 1 ? 3 : 2);
}

function RunTable({ rows, caption }: { rows: LatestRun[]; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
      <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-muted">
            {[
              'Suite',
              'Mode',
              'Run',
              'Cases',
              'Hard gates',
              'Quality metrics',
              'Cost',
              'p95 latency',
              'Result',
            ].map((h) => (
              <th key={h} scope="col" className="px-3 py-3 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ run, date, sha }) => {
            const passedGates = run.hardGates.filter((g) => g.passed).length;
            const models = [...new Set(Object.values(run.models))].join(', ');
            return (
              <tr key={`${run.suite}-${run.mode}`} className="border-b border-border last:border-0">
                <td className="px-3 py-3 font-semibold">{run.suite}</td>
                <td className="px-3 py-3">
                  <Badge tone={run.mode === 'real' ? 'accent' : 'neutral'}>{run.mode}</Badge>
                  {models ? <div className="mt-1 text-xs text-muted">{models}</div> : null}
                </td>
                <td className="px-3 py-3 text-xs text-muted">
                  {date}
                  <br />
                  {sha}
                </td>
                <td className="px-3 py-3 tabular-nums">{run.cases}</td>
                <td className="px-3 py-3 tabular-nums">
                  <details open={!run.passed}>
                    <summary className="cursor-pointer">
                      {passedGates}/{run.hardGates.length}
                    </summary>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {run.hardGates.map((g) => (
                        <li
                          key={g.metric}
                          className={g.passed ? 'text-ok' : 'font-semibold text-danger'}
                        >
                          {g.passed ? '✓' : '✗'} {g.metric} {g.rule} (got {formatMetric(g.value)})
                        </li>
                      ))}
                    </ul>
                  </details>
                </td>
                <td className="px-3 py-3 tabular-nums">
                  {run.softMetrics.length === 0 ? (
                    <span className="text-muted">-</span>
                  ) : (
                    <details>
                      <summary className="cursor-pointer">
                        {run.softMetrics.length} metrics
                        {run.softRegressions > 0 ? `, ${run.softRegressions} regressed` : ''}
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {run.softMetrics.map((m) => (
                          <li key={m.metric}>
                            {m.metric}: {formatMetric(m.value)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
                <td className="px-3 py-3 tabular-nums">
                  {run.mode === 'real' ? `$${run.costUsd.toFixed(3)}` : '-'}
                </td>
                <td className="px-3 py-3 tabular-nums">{Math.round(run.latencyP95Ms)} ms</td>
                <td className="px-3 py-3">
                  <Badge tone={run.passed ? 'ok' : 'danger'}>{run.passed ? 'pass' : 'fail'}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function EvalsPage() {
  const email = (await currentAdmin()) ?? '';
  const result = await adminFetch<{ reports: EvalReport[] }>(email, '/evals');
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Evals" description="Latest eval results and their safety gates." />
        <ErrorNote result={result} />
      </>
    );
  }
  const reports = result.data.reports;

  // The newest result per suite + mode, across every synced report (reports are sorted newest first).
  // A real-model run is often a single-suite report, so "the latest report" alone would hide the others.
  const latestByKey = new Map<string, LatestRun>();
  for (const report of reports) {
    for (const run of report.runs) {
      const key = `${run.suite} · ${run.mode}`;
      if (!latestByKey.has(key)) latestByKey.set(key, { run, date: report.date, sha: report.sha });
    }
  }
  const latestRuns = [...latestByKey.values()].sort((a, b) =>
    a.run.suite.localeCompare(b.run.suite),
  );
  const realRuns = latestRuns.filter((r) => r.run.mode === 'real');
  const offlineRuns = latestRuns.filter((r) => r.run.mode !== 'real');
  const realCost = realRuns.reduce((sum, r) => sum + r.run.costUsd, 0);
  const realFailed = realRuns.filter((r) => !r.run.passed);

  // Per suite+mode: pass/fail history, oldest first, across every synced report.
  const history = new Map<string, { date: string; passed: boolean }[]>();
  for (const report of [...reports].reverse()) {
    for (const run of report.runs) {
      const key = `${run.suite} · ${run.mode}`;
      history.set(key, [...(history.get(key) ?? []), { date: report.date, passed: run.passed }]);
    }
  }

  return (
    <>
      <PageHeader title="Evals" description="Latest eval results and their safety gates." />
      {latestRuns.length === 0 ? (
        <p className="text-muted">
          No eval reports were synced (run `make admin-data` after `make eval`).
        </p>
      ) : (
        <>
          <Card className="space-y-2">
            <h2 className="font-bold">
              Real-model runs{' '}
              {realRuns.length === 0 ? (
                <Badge tone="warn">none yet</Badge>
              ) : (
                <Badge tone={realFailed.length === 0 ? 'ok' : 'danger'}>
                  {realFailed.length === 0
                    ? 'all gates passed'
                    : `${realFailed.length} of ${realRuns.length} failing`}
                </Badge>
              )}
            </h2>
            <p className="text-sm text-muted">
              {realRuns.length === 0
                ? 'Only offline runs exist. Run `make eval SUITE=<x> MODE=real EVAL_MAX_USD=<n>`, then `make admin-data`.'
                : `Measured with a real provider. Total cost of the latest real runs: $${realCost.toFixed(3)} (prices in pricing.yaml may still be placeholders). Synthetic documents only.`}
            </p>
          </Card>
          {realRuns.length > 0 ? (
            <RunTable rows={realRuns} caption="Latest real-model run per suite" />
          ) : null}

          <h2 className="mt-6 font-bold">Offline runs (fake models)</h2>
          <p className="text-sm text-muted">
            Fake models prove the plumbing and the deterministic safety rules, not reading accuracy.
          </p>
          {offlineRuns.length > 0 ? (
            <RunTable rows={offlineRuns} caption="Latest offline run per suite" />
          ) : null}

          <Card>
            <h2 className="mb-3 font-bold">Trend per suite (oldest to newest)</h2>
            <ul className="space-y-2">
              {[...history.entries()].map(([name, points]) => (
                <li key={name} className="flex flex-wrap items-center gap-3">
                  <span className="w-56 text-sm font-semibold">{name}</span>
                  <span
                    className="flex gap-1"
                    role="img"
                    aria-label={`${points.filter((p) => p.passed).length} of ${points.length} reports passed`}
                  >
                    {points.map((p, i) => (
                      <span
                        key={i}
                        title={`${p.date}: ${p.passed ? 'pass' : 'fail'}`}
                        className={`inline-block size-4 rounded-full ${p.passed ? 'bg-ok' : 'bg-danger'}`}
                      />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
