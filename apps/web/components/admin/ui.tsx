import Link from 'next/link';
import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import type { GatewayResult } from '@/lib/gateway';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h1 className="text-2xl font-extrabold sm:text-3xl">{title}</h1>
      {children}
    </div>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  const color =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'ok'
          ? 'text-ok'
          : '';
  return (
    <Card className="p-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd>
        <span className={`block text-2xl font-extrabold tabular-nums ${color}`}>{value}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </dd>
    </Card>
  );
}

export function ErrorNote({ result }: { result: Extract<GatewayResult<unknown>, { ok: false }> }) {
  return (
    <div role="alert" className="rounded-xl border border-danger bg-danger-soft p-4 text-danger">
      <p className="font-semibold">The gateway did not answer ({result.code}).</p>
      <p className="text-sm">
        {result.status === 404
          ? 'The admin API is not enabled on the gateway (ADMIN_EMAILS / ADMIN_JWT_SECRET).'
          : 'Check that the gateway is running and that ADMIN_JWT_SECRET matches on both sides.'}
      </p>
    </div>
  );
}

export function RangeLinks({ current, base }: { current: string; base: string }) {
  return (
    <nav aria-label="Range" className="flex gap-1">
      {['7d', '30d', '90d'].map((range) => (
        <Link
          key={range}
          href={`${base}?range=${range}`}
          aria-current={current === range ? 'true' : undefined}
          className={`inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-semibold ${
            current === range ? 'bg-primary text-primary-ink' : 'bg-surface-2 hover:bg-border'
          }`}
        >
          {range}
        </Link>
      ))}
    </nav>
  );
}
