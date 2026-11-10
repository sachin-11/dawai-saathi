import { ErrorNote, PageHeader } from '@/components/admin/ui';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { EvalReport } from '@/lib/admin-types';
import { adminFetch, currentAdmin } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Evals' };

export default async function EvalsPage() {
  const email = (await currentAdmin()) ?? '';
  const result = await adminFetch<{ reports: EvalReport[] }>(email, '/evals');
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Evals" description="Latest eval reports and their safety gates." />
        <ErrorNote result={result} />
      </>
    );
  }
  const reports = result.data.reports;
  const latest = reports[0];

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
      <PageHeader title="Evals" description="Latest eval reports and their safety gates." />
      {!latest ? (
        <p className="text-muted">
          No eval reports were synced (run `make admin-data` after `make eval`).
        </p>
      ) : (
        <>
          <Card className="space-y-2">
            <h2 className="font-bold">
              Latest report: {latest.date} · {latest.sha}{' '}
              <Badge tone={latest.passed ? 'ok' : 'danger'}>
                {latest.passed ? 'all gates passed' : 'a gate failed'}
              </Badge>
            </h2>
            <p className="text-sm text-muted">
              {latest.scope}. Fake-model runs prove the plumbing and the deterministic safety rules,
              not reading accuracy.
            </p>
          </Card>

          <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
            <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
              <caption className="sr-only">Hard-gate status of the latest report</caption>
              <thead>
                <tr className="border-b border-border text-muted">
                  {[
                    'Suite',
                    'Mode',
                    'Cases',
                    'Hard gates',
                    'Soft regressions',
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
                {latest.runs.map((run) => {
                  const passedGates = run.hardGates.filter((g) => g.passed).length;
                  return (
                    <tr
                      key={`${run.suite}-${run.mode}`}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-3 py-3 font-semibold">{run.suite}</td>
                      <td className="px-3 py-3">{run.mode}</td>
                      <td className="px-3 py-3 tabular-nums">{run.cases}</td>
                      <td className="px-3 py-3 tabular-nums">
                        <details>
                          <summary className="cursor-pointer">
                            {passedGates}/{run.hardGates.length}
                          </summary>
                          <ul className="mt-1 space-y-0.5 text-xs">
                            {run.hardGates.map((g) => (
                              <li
                                key={g.metric}
                                className={g.passed ? 'text-ok' : 'font-semibold text-danger'}
                              >
                                {g.passed ? '✓' : '✗'} {g.metric} {g.rule} (got {g.value})
                              </li>
                            ))}
                          </ul>
                        </details>
                      </td>
                      <td className="px-3 py-3 tabular-nums">{run.softRegressions}</td>
                      <td className="px-3 py-3 tabular-nums">{Math.round(run.latencyP95Ms)} ms</td>
                      <td className="px-3 py-3">
                        <Badge tone={run.passed ? 'ok' : 'danger'}>
                          {run.passed ? 'pass' : 'fail'}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

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
