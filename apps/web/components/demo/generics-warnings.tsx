'use client';

import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import type { DemoExtraction, DemoWarning } from '@/lib/demo-types';

const inr = (value: number): string => `₹${value.toFixed(value < 10 ? 2 : 0)}`;

export function GenericsView({ extraction }: { extraction: DemoExtraction | null | undefined }) {
  const t = useTranslations('demo.generics');
  const medicines = (extraction?.kind === 'prescription' ? extraction.medicines : undefined) ?? [];
  const rows = medicines.filter((m) => (m.generic?.alternatives?.length ?? 0) > 0);
  if (rows.length === 0) return <p className="text-muted">{t('noneAny')}</p>;
  return (
    <div className="space-y-4">
      {rows.map((medicine, index) => {
        const generic = medicine.generic;
        return (
          <section
            key={index}
            className="rounded-xl border border-border p-4"
            aria-label={medicine.name?.value ?? ''}
          >
            <h3 className="font-semibold">{medicine.name?.value}</h3>
            <ul className="mt-2 space-y-2">
              {generic?.alternatives?.map((alt) => (
                <li
                  key={alt.brand_name}
                  data-testid="generic-alt"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 p-3"
                >
                  <span className="flex items-center gap-2 font-medium">
                    {alt.brand_name}
                    {alt.is_janaushadhi && <Badge tone="primary">{t('janAushadhi')}</Badge>}
                  </span>
                  <span className="text-sm tabular-nums">
                    {inr(alt.price_per_unit)} {t('perUnit')}
                    {alt.approx_savings != null &&
                      alt.approx_savings > 0 &&
                      generic?.savings_known && (
                        <Badge tone="ok" className="ml-2">
                          {t('saving')}: {inr(alt.approx_savings)}
                        </Badge>
                      )}
                  </span>
                </li>
              ))}
            </ul>
            {generic?.price_source_date && (
              <p className="mt-2 text-xs text-muted">
                {t('priceDate')} {generic.price_source_date}
              </p>
            )}
          </section>
        );
      })}
      <p className="text-sm text-muted">{t('note')}</p>
    </div>
  );
}

export function WarningsView({ warnings }: { warnings: readonly DemoWarning[] }) {
  const t = useTranslations('demo.warnings');
  if (warnings.length === 0) return <p className="text-muted">{t('none')}</p>;
  const knownTypes = ['low_confidence', 'interaction', 'critical_value'];
  return (
    <ul className="space-y-3">
      {warnings.map((warning, index) => (
        <li
          key={index}
          data-testid="warning"
          className="rounded-xl border border-border border-l-4 border-l-warn bg-warn-soft p-3"
        >
          <Badge tone={warning.type === 'critical_value' ? 'danger' : 'warn'}>
            {knownTypes.includes(warning.type)
              ? t(`types.${warning.type}` as 'types.interaction')
              : warning.type}
          </Badge>
          <p className="mt-1 text-sm">{warning.detail}</p>
        </li>
      ))}
    </ul>
  );
}
