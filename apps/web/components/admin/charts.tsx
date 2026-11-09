'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/** Theme colours come from CSS variables, so the charts follow light/dark mode without a re-render. */
const C = {
  grid: 'var(--border)',
  axis: 'var(--muted)',
  primary: 'var(--primary)',
  accent: 'var(--accent)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
} as const;

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--ink)',
};

function Frame({
  label,
  summary,
  children,
}: {
  label: string;
  summary: string;
  children: React.ReactElement;
}) {
  return (
    <figure className="m-0" aria-label={label}>
      <div role="img" aria-label={`${label}. ${summary}`} className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function DocsPerDayChart({
  data,
}: {
  data: { day: string; prescription: number; lab_report: number; unknown: number }[];
}) {
  const total = data.reduce((n, d) => n + d.prescription + d.lab_report + d.unknown, 0);
  return (
    <Frame label="Documents per day" summary={`${total} documents over ${data.length} days.`}>
      <BarChart data={data} margin={{ left: -16, right: 8 }}>
        <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="day"
          stroke={C.axis}
          tick={{ fontSize: 11 }}
          tickFormatter={(d: string) => d.slice(5)}
        />
        <YAxis stroke={C.axis} allowDecimals={false} tick={{ fontSize: 11 }} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend />
        <Bar dataKey="prescription" stackId="a" fill={C.primary} name="Prescriptions" />
        <Bar dataKey="lab_report" stackId="a" fill={C.accent} name="Lab reports" />
        <Bar dataKey="unknown" stackId="a" fill={C.axis} name="Other" />
      </BarChart>
    </Frame>
  );
}

export function CostPerDayChart({
  data,
}: {
  data: { day: string; usd: number; demoUsd: number }[];
}) {
  const total = data.reduce((n, d) => n + d.usd + d.demoUsd, 0);
  return (
    <Frame
      label="LLM cost per day (USD)"
      summary={`$${total.toFixed(4)} over ${data.length} days.`}
    >
      <LineChart data={data} margin={{ left: -8, right: 8 }}>
        <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="day"
          stroke={C.axis}
          tick={{ fontSize: 11 }}
          tickFormatter={(d: string) => d.slice(5)}
        />
        <YAxis stroke={C.axis} tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => `$${Number(v).toFixed(4)}`} />
        <Legend />
        <Line
          type="monotone"
          dataKey="usd"
          name="Users"
          stroke={C.primary}
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="demoUsd"
          name="Web demo"
          stroke={C.accent}
          strokeWidth={2}
          dot={false}
          strokeDasharray="5 3"
        />
      </LineChart>
    </Frame>
  );
}

export function CategoryBars({
  label,
  data,
  color,
}: {
  label: string;
  data: { name: string; value: number }[];
  color: 'primary' | 'danger' | 'ok';
}) {
  const total = data.reduce((n, d) => n + d.value, 0);
  return (
    <Frame label={label} summary={`${total} in total.`}>
      <BarChart data={data} layout="vertical" margin={{ left: 24, right: 8 }}>
        <CartesianGrid stroke={C.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" stroke={C.axis} allowDecimals={false} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="name" stroke={C.axis} width={110} tick={{ fontSize: 11 }} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey="value" fill={C[color]} name={label} />
      </BarChart>
    </Frame>
  );
}
