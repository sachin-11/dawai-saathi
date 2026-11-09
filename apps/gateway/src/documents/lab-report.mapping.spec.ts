import type { LabReportExtraction } from '../ai-client/types';
import { isOutside, mapLabResults, reportDateOf } from './lab-report.mapping';

const f = <T>(value: T | null, confidence = 0.95): { value: T | null; confidence: number } => ({
  value,
  confidence,
});

function result(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    raw_test_name: f('Haemoglobin'),
    value_raw: f('11.2'),
    unit: f('g/dL'),
    lab_ref_low: f(12),
    lab_ref_high: f(15.5),
    lab_ref_text: f('12 - 15.5'),
    lab_flag: f('L'),
    section: 'CBC',
    test_code: 'HB',
    value_num: 11.2,
    value_comparator: '=',
    value_canonical: 11.2,
    unit_canonical: 'g/dl',
    status: 'low',
    ...overrides,
  };
}

function extraction(
  results: Record<string, unknown>[],
  reportDate = f('2026-11-12'),
): LabReportExtraction {
  return {
    kind: 'lab_report',
    is_lab_report: true,
    image_quality: 'good',
    report_date: reportDate,
    patient_age: f(45),
    patient_sex: f('f'),
    results,
    overall_confidence: 0.9,
    status: 'done',
  } as unknown as LabReportExtraction;
}

describe('mapLabResults', () => {
  it('keeps the canonical value, the printed value and the status, and nothing else', () => {
    expect(mapLabResults(extraction([result({})]))).toEqual([
      {
        testCode: 'HB',
        valueNumCanonical: 11.2,
        unitCanonical: 'g/dl',
        valueRaw: '11.2',
        unitRaw: 'g/dL',
        status: 'low',
      },
    ]);
  });

  it('a limit value like "<0.5" keeps no number for trends', () => {
    const [row] = mapLabResults(
      extraction([result({ value_raw: f('<0.5'), value_comparator: '<', value_canonical: 0.5 })]),
    );
    expect(row?.valueNumCanonical).toBeNull();
    expect(row?.valueRaw).toBe('<0.5');
  });

  it('an unknown test keeps no code, and a result without a value is skipped', () => {
    const rows = mapLabResults(
      extraction([
        result({ test_code: null, value_canonical: null, unit_canonical: null, status: 'unknown' }),
        result({ value_raw: f(null, 0.1) }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ testCode: null, valueNumCanonical: null, status: 'unknown' });
  });

  it('stores no name, id or comment of the report', () => {
    const [row] = mapLabResults(extraction([result({ raw_test_name: f('Haemoglobin') })]));
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'status',
      'testCode',
      'unitCanonical',
      'unitRaw',
      'valueNumCanonical',
      'valueRaw',
    ]);
  });
});

describe('reportDateOf', () => {
  it('returns the date only when it was read with enough confidence', () => {
    expect(reportDateOf(extraction([]))?.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(reportDateOf(extraction([], f('2026-11-12', 0.4)))).toBeNull();
    expect(reportDateOf(extraction([], f(null, 0)))).toBeNull();
    expect(reportDateOf(extraction([], f('not-a-date')))).toBeNull();
  });
});

describe('isOutside', () => {
  it.each(['high', 'low', 'critical_high', 'critical_low', 'qualitative_abnormal'])(
    '%s is outside the range',
    (status) => {
      expect(isOutside(status)).toBe(true);
    },
  );
  it.each(['normal', 'borderline', 'unknown'])('%s is not', (status) => {
    expect(isOutside(status)).toBe(false);
  });
});
