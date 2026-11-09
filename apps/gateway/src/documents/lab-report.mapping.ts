import type { LabReportExtraction, LabResultItem } from '../ai-client/types';

export type { LabReportExtraction, LabResultItem };

/** A result outside its range (or critical): counted in the REPORTS list and in the summary. */
const OUTSIDE = new Set(['high', 'low', 'critical_high', 'critical_low', 'qualitative_abnormal']);

export function isOutside(status: string): boolean {
  return OUTSIDE.has(status);
}

/** The report date only when it was read with enough confidence (same 0.75 as the AI service). */
export function reportDateOf(extraction: LabReportExtraction, minimum = 0.75): Date | null {
  const field = extraction.report_date;
  if (!field.value || field.confidence < minimum) return null;
  const date = new Date(`${field.value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface LabResultRow {
  testCode: string | null;
  valueNumCanonical: number | null;
  unitCanonical: string | null;
  valueRaw: string;
  unitRaw: string | null;
  status: NonNullable<LabResultItem['status']>;
}

/**
 * The rows kept for trends and REPORTS. Only what is needed to compare later: the code, the canonical
 * value and unit, the value as printed, the status. A result that was not read at all is skipped.
 */
export function mapLabResults(extraction: LabReportExtraction): LabResultRow[] {
  return (extraction.results ?? []).flatMap((result) => {
    const valueRaw = result.value_raw.value;
    if (!valueRaw) return [];
    // A limit value ("<0.5") has no exact number: it is kept as printed but never used for a trend.
    const exact = result.value_comparator === '=';
    return [
      {
        testCode: result.test_code ?? null,
        valueNumCanonical:
          exact && typeof result.value_canonical === 'number' ? result.value_canonical : null,
        unitCanonical: result.unit_canonical ?? null,
        valueRaw: valueRaw.slice(0, 40),
        unitRaw: result.unit.value?.slice(0, 40) ?? null,
        status: result.status,
      },
    ];
  });
}
