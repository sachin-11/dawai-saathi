import {
  type ClockTimes,
  endDateFor,
  type ExtractedMedicine,
  mapMedications,
  matchFields,
  medicineConfidence,
  type PrescriptionExtraction,
  todayInIndia,
  toClockTimes,
} from './prescription.mapping';

const CLOCK: ClockTimes = {
  morning: '08:00',
  afternoon: '14:00',
  evening: '18:00',
  night: '21:00',
};

const f = <T>(value: T | null, confidence = 0.95) => ({ value, confidence });

const medicine = (overrides: Partial<ExtractedMedicine> = {}): ExtractedMedicine =>
  ({
    raw_text: f('Tab. Dolo 650 1-0-1 x 5 days'),
    name: f('Dolo 650'),
    form: f('tablet'),
    strength: f('650 mg', 0.8),
    dose: f('1 tablet'),
    frequency_code: f('1-0-1'),
    frequency_per_day: f(2),
    timings: f(['morning', 'night'], 0.9),
    relation_to_food: f('after', 0.9),
    duration_days: f(5),
    as_needed: false,
    instructions: f(null, 0),
    low_confidence: false,
    ...overrides,
  }) as unknown as ExtractedMedicine;

const extraction = (...medicines: ExtractedMedicine[]): PrescriptionExtraction =>
  ({
    kind: 'prescription',
    is_prescription: true,
    image_quality: 'good',
    medicines,
    prescription_date: f(null, 0),
    overall_confidence: 0.9,
    notes_for_user: [],
    status: 'done',
  }) as unknown as PrescriptionExtraction;

// 2026-11-08 21:00 UTC is already 2026-11-09 02:30 in India.
const NOW = new Date('2026-11-08T21:00:00Z');

describe('todayInIndia', () => {
  it('uses the Indian calendar date, not the UTC one', () => {
    expect(todayInIndia(NOW).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(todayInIndia(new Date('2026-11-08T05:00:00Z')).toISOString()).toBe(
      '2026-11-08T00:00:00.000Z',
    );
  });
});

describe('endDateFor', () => {
  const start = new Date('2026-11-09T00:00:00.000Z');
  it('is inclusive: 5 days starting today ends on the 5th day', () => {
    expect(endDateFor(start, 5)?.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(endDateFor(start, 1)?.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });
  it('is null when there is no duration', () => {
    expect(endDateFor(start, null)).toBeNull();
    expect(endDateFor(start, 0)).toBeNull();
  });
});

describe('toClockTimes', () => {
  it('maps times of day to the configured clock times, sorted and without repeats', () => {
    expect(toClockTimes(['night', 'morning', 'morning'], CLOCK)).toEqual(['08:00', '21:00']);
  });
  it('honours a custom mapping', () => {
    expect(toClockTimes(['morning'], { ...CLOCK, morning: '07:30' })).toEqual(['07:30']);
  });
  it('ignores unknown names and handles null', () => {
    expect(toClockTimes(['lunch'], CLOCK)).toEqual([]);
    expect(toClockTimes(null, CLOCK)).toEqual([]);
  });
});

describe('medicineConfidence', () => {
  it('is the weakest of name, dose and frequency', () => {
    expect(medicineConfidence(medicine({ dose: f('1 tablet', 0.6) }))).toBe(0.6);
  });
  it('is 0 when a critical value is missing', () => {
    expect(medicineConfidence(medicine({ name: f(null, 0.9) }))).toBe(0);
  });
  it('an as-needed medicine needs only a readable code', () => {
    const sos = medicine({
      as_needed: true,
      frequency_code: f('SOS', 0.9),
      frequency_per_day: f(null, 0),
    });
    expect(medicineConfidence(sos)).toBe(0.9);
  });
});

describe('mapMedications', () => {
  it('maps a clear medicine to an active row with clock times and dates', () => {
    const [row] = mapMedications(extraction(medicine()), CLOCK, NOW);
    expect(row).toEqual({
      rawName: 'Dolo 650',
      strength: '650 mg',
      form: 'tablet',
      dose: '1 tablet',
      frequencyPerDay: 2,
      asNeeded: false,
      timings: ['08:00', '21:00'],
      relationToFood: 'after',
      durationDays: 5,
      startDate: new Date('2026-11-09T00:00:00.000Z'),
      endDate: new Date('2026-11-13T00:00:00.000Z'),
      confidence: 0.95,
      active: true,
      drugId: null,
      salt: null,
      saltKey: null,
      strengthKey: null,
      formKey: null,
      releaseType: null,
      matchScore: null,
      matchMethod: null,
    });
  });

  it('a low-confidence medicine is saved but NOT active', () => {
    const [row] = mapMedications(extraction(medicine({ low_confidence: true })), CLOCK, NOW);
    expect(row?.active).toBe(false);
  });

  it('an unreadable name falls back to the written line, then to "unreadable"', () => {
    const rows = mapMedications(
      extraction(
        medicine({ name: f(null, 0.1), low_confidence: true }),
        medicine({ name: f(null, 0.1), raw_text: f(null, 0), low_confidence: true }),
      ),
      CLOCK,
      NOW,
    );
    expect(rows.map((r) => r.rawName)).toEqual(['Tab. Dolo 650 1-0-1 x 5 days', 'unreadable']);
  });

  it('as-needed has no daily count; a missing food relation becomes "any"', () => {
    const [row] = mapMedications(
      extraction(
        medicine({
          as_needed: true,
          frequency_per_day: f(3),
          relation_to_food: f(null, 0),
          duration_days: f(null, 0),
        }),
      ),
      CLOCK,
      NOW,
    );
    expect(row).toMatchObject({
      asNeeded: true,
      frequencyPerDay: null,
      relationToFood: 'any',
      durationDays: null,
      endDate: null,
    });
  });

  it('stores the catalog match on the row (M8)', () => {
    const matched = medicine({
      match: { ...MATCH },
    });
    const [row] = mapMedications(extraction(matched), CLOCK, NOW);
    expect(row).toMatchObject({
      drugId: DRUG,
      salt: 'paracetamol',
      // M11: `salt_key` is the salt the interaction checker used, never a raw catalog match
      saltKey: null,
      strengthKey: '650mg',
      formKey: 'tablet',
      releaseType: 'ir',
      matchScore: 1,
      matchMethod: 'exact',
    });
  });

  it('takes salt_key ONLY from the interaction report, by medicine index (M11)', () => {
    const rows = mapMedications(
      extraction(medicine({ match: { ...MATCH } }), medicine({ match: { ...MATCH } })),
      CLOCK,
      NOW,
      new Map([[1, 'paracetamol']]),
    );
    expect(rows.map((row) => row.saltKey)).toEqual([null, 'paracetamol']);
  });

  it('copes with a response that omits the medicines list', () => {
    const empty = { ...extraction(), medicines: undefined } as unknown as PrescriptionExtraction;
    expect(mapMedications(empty, CLOCK, NOW)).toEqual([]);
  });
});

const DRUG = '3f2b8c1e-5d0a-4b7e-9c61-0a1b2c3d4e5f';
const MATCH = {
  drug_id: DRUG,
  brand_name: 'Dolo 650',
  salt_key: 'paracetamol',
  strength_key: '650mg',
  form_key: 'tablet',
  release_type: 'ir',
  score: 1,
  method: 'exact',
  candidates: [],
  strength_basis: 'brand_name',
  strength_conflict: false,
  form_conflict: false,
  ambiguous: false,
} as unknown as NonNullable<ExtractedMedicine['match']>;

describe('matchFields', () => {
  it('no match at all -> everything null', () => {
    expect(matchFields(null)).toMatchObject({ salt: null, matchMethod: null, drugId: null });
    expect(matchFields(undefined)).toMatchObject({ saltKey: null });
  });

  it('method none keeps the method and score but invents no keys', () => {
    const none = { ...MATCH, method: 'none', salt_key: null, drug_id: null, score: 0 };
    expect(matchFields(none as typeof MATCH)).toMatchObject({
      matchMethod: 'none',
      matchScore: 0,
      salt: null,
      saltKey: null,
      drugId: null,
    });
  });

  it('an ambiguous match keeps the salt the matcher stated but no product keys', () => {
    expect(matchFields({ ...MATCH, ambiguous: true })).toMatchObject({
      salt: 'paracetamol',
      strengthKey: null,
      formKey: null,
      releaseType: null,
      drugId: null,
      matchMethod: 'exact',
    });
  });

  it('an ambiguous match with no common salt stores none', () => {
    expect(matchFields({ ...MATCH, ambiguous: true, salt_key: null })).toMatchObject({
      salt: null,
      saltKey: null,
    });
  });

  it('a conflict keeps the salt but not the catalog strength, form, release or product', () => {
    expect(matchFields({ ...MATCH, strength_conflict: true })).toMatchObject({
      salt: 'paracetamol',
      strengthKey: null,
      formKey: null,
      releaseType: null,
      drugId: null,
    });
    expect(matchFields({ ...MATCH, form_conflict: true })).toMatchObject({ strengthKey: null });
  });

  it('a salt-written match has no product id', () => {
    const written = { ...MATCH, method: 'salt_written', drug_id: null, brand_name: null };
    expect(matchFields(written as typeof MATCH)).toMatchObject({
      drugId: null,
      saltKey: 'paracetamol',
      matchMethod: 'salt_written',
    });
  });

  it('a product id that is not a uuid is never sent to the database', () => {
    expect(matchFields({ ...MATCH, drug_id: 'id-3' })).toMatchObject({ drugId: null });
  });

  it('an unknown release type is dropped rather than stored', () => {
    expect(matchFields({ ...MATCH, release_type: 'weird' })).toMatchObject({ releaseType: null });
  });
});
