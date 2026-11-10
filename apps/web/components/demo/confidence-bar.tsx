import { cn } from '@/lib/utils';

export const CONFIDENCE_THRESHOLD = 0.75;

/** A confidence value as a bar plus the number (never colour alone), red below the project threshold. */
export function ConfidenceBar({
  value,
  label,
  className,
}: {
  value: number | null | undefined;
  label: string;
  className?: string;
}) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const pct = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : 0;
  const low = !known || (value as number) < CONFIDENCE_THRESHOLD;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 w-16 shrink-0 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          data-testid="confidence-fill"
          className={cn('h-full rounded-full', low ? 'bg-danger' : 'bg-ok')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn('text-xs tabular-nums', low ? 'font-semibold text-danger' : 'text-muted')}
      >
        {known ? `${pct}%` : '–'}
      </span>
    </div>
  );
}
