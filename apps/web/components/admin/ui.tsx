import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import type { GatewayResult } from '@/lib/gateway';

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

const TONE_ICON = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  none: 'bg-primary-soft text-primary',
} as const;

export function Kpi({
  label,
  value,
  hint,
  tone,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger';
  icon?: LucideIcon;
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
    <Card className="flex items-start gap-3 p-4">
      {Icon && (
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-xl ${TONE_ICON[tone ?? 'none']}`}
        >
          <Icon className="size-5" aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <dt className="text-sm font-medium text-muted">{label}</dt>
        <dd>
          <span className={`block text-2xl font-extrabold tabular-nums ${color}`}>{value}</span>
          {hint && <span className="block text-xs text-muted">{hint}</span>}
        </dd>
      </div>
    </Card>
  );
}

/** A titled card with an icon; the shared shape of every panel on the admin pages. */
export function Panel({
  title,
  icon: Icon,
  children,
  aside,
}: {
  title: string;
  icon?: LucideIcon;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-bold">
          {Icon && <Icon className="size-[18px] text-muted" aria-hidden />}
          {title}
        </h2>
        {aside}
      </div>
      {children}
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
    <nav aria-label="Range" className="inline-flex gap-1 rounded-xl bg-surface-2 p-1">
      {['7d', '30d', '90d'].map((range) => (
        <Link
          key={range}
          href={`${base}?range=${range}`}
          aria-current={current === range ? 'true' : undefined}
          className={`inline-flex min-h-9 items-center rounded-lg px-3.5 text-sm font-semibold transition-colors ${
            current === range ? 'bg-surface text-primary shadow-sm' : 'text-muted hover:text-ink'
          }`}
        >
          {range}
        </Link>
      ))}
    </nav>
  );
}
