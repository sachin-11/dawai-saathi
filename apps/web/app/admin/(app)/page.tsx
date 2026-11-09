import { CategoryBars, CostPerDayChart, DocsPerDayChart } from '@/components/admin/charts';
import { ErrorNote, Kpi, PageHeader, RangeLinks } from '@/components/admin/ui';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { AdminStats } from '@/lib/admin-types';
import { adminFetch, currentAdmin } from '@/lib/gateway';

export const dynamic = 'force-dynamic';

const RANGES = ['7d', '30d', '90d'];

function pivotDocs(rows: AdminStats['documentsByDay']) {
  const days = new Map<
    string,
    { day: string; prescription: number; lab_report: number; unknown: number }
  >();
  for (const row of rows) {
    const entry = days.get(row.day) ?? { day: row.day, prescription: 0, lab_report: 0, unknown: 0 };
    const kind = row.kind === 'prescription' || row.kind === 'lab_report' ? row.kind : 'unknown';
    entry[kind] += row.n;
    days.set(row.day, entry);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${Math.round(value * 100)}%`;

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: raw } = await searchParams;
  const range = RANGES.includes(raw ?? '') ? (raw as string) : '7d';
  const email = (await currentAdmin()) ?? '';
  const result = await adminFetch<AdminStats>(email, `/stats?range=${range}`);

  return (
    <>
      <PageHeader title="Overview">
        <RangeLinks current={range} base="/admin" />
      </PageHeader>
      {!result.ok ? <ErrorNote result={result} /> : <Overview stats={result.data} />}
    </>
  );
}

function Overview({ stats }: { stats: AdminStats }) {
  const docs = pivotDocs(stats.documentsByDay);
  const totalDocs = docs.reduce((n, d) => n + d.prescription + d.lab_report + d.unknown, 0);
  const emergencies = stats.emergenciesByCategory.reduce((n, e) => n + e.n, 0);
  const budgetTone =
    stats.budget.state === 'normal' ? 'ok' : stats.budget.state === 'economy' ? 'warn' : 'danger';
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Users"
          value={stats.users.total}
          hint={`${stats.users.new} new · ${stats.users.active7d} active in 7 days`}
        />
        <Kpi label={`Documents (${stats.range})`} value={totalDocs} />
        <Kpi
          label="Average confidence"
          value={pct(stats.averageConfidence)}
          tone={
            stats.averageConfidence !== null && stats.averageConfidence < 0.75 ? 'warn' : undefined
          }
        />
        <Kpi
          label="Needs review"
          value={stats.needsReview}
          tone={stats.needsReview > 0 ? 'warn' : 'ok'}
          hint="Unreviewed documents"
        />
        <Kpi
          label="Reminder ack rate"
          value={pct(stats.reminders.ackRate)}
          hint={`${stats.reminders.taken} taken · ${stats.reminders.missed} missed · ${stats.reminders.skipped} skipped`}
        />
        <Kpi
          label="Emergencies"
          value={emergencies}
          hint="Category only; never the text"
          tone={emergencies > 0 ? 'warn' : undefined}
        />
        <Kpi
          label="LLM spend today"
          value={`$${stats.budget.spentUsd.toFixed(2)}`}
          hint={`${Math.round(stats.budget.ratio * 100)}% of the daily budget`}
        />
        <Card className="p-4">
          <dt className="text-sm text-muted">Budget state</dt>
          <dd>
            <Badge tone={budgetTone} className="mt-1 text-base">
              {stats.budget.state}
            </Badge>
          </dd>
          {stats.budget.demoExhausted && (
            <p className="mt-1 text-xs text-warn">Web demo budget used up</p>
          )}
        </Card>
      </dl>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <h2 className="mb-2 font-bold">Documents per day</h2>
          {docs.length ? (
            <DocsPerDayChart data={docs} />
          ) : (
            <p className="text-muted">No documents in this range.</p>
          )}
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">LLM cost per day</h2>
          <CostPerDayChart data={stats.costByDay} />
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Reminder answers</h2>
          <CategoryBars
            label="Reminder answers"
            color="ok"
            data={[
              { name: 'taken', value: stats.reminders.taken },
              { name: 'missed', value: stats.reminders.missed },
              { name: 'skipped', value: stats.reminders.skipped },
            ]}
          />
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Emergencies by category</h2>
          {stats.emergenciesByCategory.length ? (
            <CategoryBars
              label="Emergencies by category"
              color="danger"
              data={stats.emergenciesByCategory.map((e) => ({ name: e.category, value: e.n }))}
            />
          ) : (
            <p className="text-muted">None in this range.</p>
          )}
        </Card>
      </div>
    </>
  );
}
