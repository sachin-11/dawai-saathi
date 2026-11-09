'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import type { DemoExtraction, LabRow, RxMedicine } from '@/lib/demo-types';
import { CONFIDENCE_THRESHOLD, ConfidenceBar } from './confidence-bar';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  normal: 'ok',
  borderline: 'warn',
  high: 'warn',
  low: 'warn',
  qualitative_abnormal: 'warn',
  critical_high: 'danger',
  critical_low: 'danger',
  unknown: 'neutral',
};

function isLow(medicine: RxMedicine): boolean {
  return Boolean(medicine.low_confidence);
}

function MedicineTable({ medicines }: { medicines: RxMedicine[] }) {
  const t = useTranslations('demo.extraction');
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption className="sr-only">{t('medicinesTitle')}</caption>
        <thead>
          <tr className="border-b border-border text-muted">
            {(['medicine', 'strength', 'dose', 'timing', 'food', 'duration'] as const).map(
              (key) => (
                <th key={key} scope="col" className="px-2 py-2 font-semibold">
                  {t(key)}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {medicines.map((medicine, index) => {
            const low = isLow(medicine);
            const name = medicine.name?.value;
            const timings = medicine.timings?.value?.join(', ');
            const food = medicine.relation_to_food?.value;
            return (
              <tr
                key={index}
                data-testid="medicine-row"
                data-low={low}
                className={low ? 'border-b border-border bg-danger-soft' : 'border-b border-border'}
              >
                <td className="px-2 py-2 align-top">
                  <div className="font-semibold">
                    {name ?? <span className="text-danger">{t('unreadable')}</span>}
                  </div>
                  <ConfidenceBar
                    value={medicine.name?.confidence}
                    label={`${t('confidence')}: ${t('medicine')}`}
                  />
                  {low && (
                    <p className="mt-1 flex items-start gap-1 text-xs font-semibold text-danger">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {t('lowConfidence')}
                    </p>
                  )}
                </td>
                <td className="px-2 py-2 align-top">{medicine.strength?.value ?? '–'}</td>
                <td className="px-2 py-2 align-top">
                  <div>{medicine.dose?.value ?? '–'}</div>
                  <ConfidenceBar
                    value={medicine.dose?.confidence}
                    label={`${t('confidence')}: ${t('dose')}`}
                  />
                </td>
                <td className="px-2 py-2 align-top">
                  <div>
                    {medicine.as_needed
                      ? t('asNeeded')
                      : (medicine.frequency_code?.value ?? timings ?? '–')}
                  </div>
                  <ConfidenceBar
                    value={medicine.frequency_code?.confidence}
                    label={`${t('confidence')}: ${t('timing')}`}
                  />
                </td>
                <td className="px-2 py-2 align-top">
                  {food ? t(`food_${food}` as 'food_before') : '–'}
                </td>
                <td className="px-2 py-2 align-top tabular-nums">
                  {medicine.duration_days?.value ?? '–'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function rangeText(row: LabRow): string {
  return row.range_text ?? row.lab_ref_text?.value ?? '–';
}

function LabTable({ rows }: { rows: LabRow[] }) {
  const t = useTranslations('demo.extraction');
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <caption className="sr-only">{t('resultsTitle')}</caption>
        <thead>
          <tr className="border-b border-border text-muted">
            {(['test', 'value', 'status', 'range'] as const).map((key) => (
              <th key={key} scope="col" className="px-2 py-2 font-semibold">
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const status = row.status ?? 'unknown';
            const value = [row.value_raw?.value, row.unit?.value].filter(Boolean).join(' ');
            const lowRead = (row.value_raw?.confidence ?? 1) < CONFIDENCE_THRESHOLD;
            return (
              <tr key={index} data-testid="lab-row" className="border-b border-border">
                <td className="px-2 py-2 align-top font-semibold">
                  {row.raw_test_name?.value ?? t('unreadable')}
                </td>
                <td className="px-2 py-2 align-top">
                  <div className="tabular-nums">{value || '–'}</div>
                  <ConfidenceBar
                    value={row.value_raw?.confidence}
                    label={`${t('confidence')}: ${t('value')}`}
                  />
                  {(lowRead || row.needs_confirmation) && (
                    <p className="text-xs font-semibold text-danger">{t('lowConfidence')}</p>
                  )}
                </td>
                <td className="px-2 py-2 align-top">
                  <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
                    {t(`statuses.${status}` as 'statuses.normal')}
                  </Badge>
                </td>
                <td className="px-2 py-2 align-top">
                  <div>{rangeText(row)}</div>
                  {row.range_basis && (
                    <Badge tone="neutral" className="mt-1">
                      {t(`rangeBasis.${row.range_basis}` as 'rangeBasis.printed')}
                    </Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ExtractionView({ extraction }: { extraction: DemoExtraction | null | undefined }) {
  const t = useTranslations('demo.extraction');
  if (!extraction) return <p className="text-muted">{t('none')}</p>;
  if (extraction.kind === 'lab_report') {
    return extraction.results?.length ? (
      <LabTable rows={extraction.results} />
    ) : (
      <p className="text-muted">{t('none')}</p>
    );
  }
  return extraction.medicines?.length ? (
    <MedicineTable medicines={extraction.medicines} />
  ) : (
    <p className="text-muted">{t('none')}</p>
  );
}
