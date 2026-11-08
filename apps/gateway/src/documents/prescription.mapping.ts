import type { components } from '../ai-client/generated/ai-service';

export type PrescriptionExtraction = components['schemas']['PrescriptionExtraction'];
export type ExtractedMedicine = components['schemas']['Medicine'];

export type TimingName = 'morning' | 'afternoon' | 'evening' | 'night';

/** Clock times (Asia/Kolkata wall clock, "HH:MM") a written time of day is saved as. */
export type ClockTimes = Readonly<Record<TimingName, string>>;

export interface MedicationRow {
  rawName: string;
  strength: string | null;
  form: string | null;
  dose: string | null;
  frequencyPerDay: number | null;
  asNeeded: boolean;
  timings: string[];
  relationToFood: 'before' | 'after' | 'with' | 'any';
  durationDays: number | null;
  startDate: Date;
  endDate: Date | null;
  /** 0..1, the weakest of name / dose / frequency (same rule as the AI service's confidence gate). */
  confidence: number;
  /** Only a medicine that passed the confidence gate is active (CLAUDE.md §2.3). */
  active: boolean;
  /** M8: what the catalog match found (all null when nothing was matched). */
  drugId: string | null;
  salt: string | null;
  saltKey: string | null;
  strengthKey: string | null;
  formKey: string | null;
  releaseType: ReleaseTypeValue | null;
  matchScore: number | null;
  matchMethod: MatchMethodValue | null;
}

export type ReleaseTypeValue = 'ir' | 'sr' | 'er' | 'xr' | 'cr' | 'mr' | 'dr' | 'na';
export type MatchMethodValue = 'exact' | 'trgm' | 'vector' | 'salt_written' | 'none';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELEASE_TYPES: ReadonlySet<string> = new Set([
  'ir',
  'sr',
  'er',
  'xr',
  'cr',
  'mr',
  'dr',
  'na',
]);

/**
 * The catalog's keys for one medicine. The SALT is kept whenever the matcher stated one, even for an
 * ambiguous or conflicting match (it is what the interaction checker needs, M11). Strength / form / release are the CATALOG product's, so
 * when the prescription contradicted them they are NOT stored: what is written wins (CLAUDE.md M8 §4).
 */
export function matchFields(
  match: ExtractedMedicine['match'],
): Pick<
  MedicationRow,
  | 'drugId'
  | 'salt'
  | 'saltKey'
  | 'strengthKey'
  | 'formKey'
  | 'releaseType'
  | 'matchScore'
  | 'matchMethod'
> {
  const empty = {
    drugId: null,
    salt: null,
    saltKey: null,
    strengthKey: null,
    formKey: null,
    releaseType: null,
    matchScore: null,
    matchMethod: null,
  } as const;
  if (!match) return empty;
  const method = match.method;
  if (method === 'none' || !match.salt_key) {
    return { ...empty, matchScore: match.score, matchMethod: method };
  }
  // A conflict or an ambiguity means the catalog PRODUCT is not certain: keep the salt (if any), no product keys.
  const conflict = match.strength_conflict || match.form_conflict || match.ambiguous;
  const release = match.release_type;
  return {
    // The product itself is only recorded when nothing contradicts it and the id is a real uuid.
    drugId: !conflict && match.drug_id && UUID.test(match.drug_id) ? match.drug_id : null,
    salt: match.salt_key,
    saltKey: match.salt_key,
    strengthKey: conflict ? null : (match.strength_key ?? null),
    formKey: conflict ? null : (match.form_key ?? null),
    releaseType:
      !conflict && release && RELEASE_TYPES.has(release) ? (release as ReleaseTypeValue) : null,
    matchScore: match.score,
    matchMethod: method,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IST = 'Asia/Kolkata';

/** Today's calendar date in India, as a UTC-midnight Date (what a `@db.Date` column stores). */
export function todayInIndia(now: Date): Date {
  // `en-CA` formats as YYYY-MM-DD.
  const iso = now.toLocaleDateString('en-CA', { timeZone: IST });
  return new Date(`${iso}T00:00:00.000Z`);
}

/** "x 5 days" starting today covers today and the next four days: the end date is INCLUSIVE. */
export function endDateFor(start: Date, durationDays: number | null): Date | null {
  return durationDays !== null && durationDays > 0
    ? new Date(start.getTime() + (durationDays - 1) * DAY_MS)
    : null;
}

export function toClockTimes(
  timings: readonly string[] | null | undefined,
  clock: ClockTimes,
): string[] {
  const times = (timings ?? []).flatMap((timing) =>
    timing in clock ? [clock[timing as TimingName]] : [],
  );
  return [...new Set(times)].sort();
}

function frequencyConfidence(medicine: ExtractedMedicine): number {
  const code = medicine.frequency_code.value ? medicine.frequency_code.confidence : 0;
  if (medicine.as_needed) return code;
  const perDay = medicine.frequency_per_day.value ? medicine.frequency_per_day.confidence : 0;
  return Math.min(code, perDay);
}

export function medicineConfidence(medicine: ExtractedMedicine): number {
  const name = medicine.name.value ? medicine.name.confidence : 0;
  const dose = medicine.dose.value ? medicine.dose.confidence : 0;
  return Math.round(Math.min(name, dose, frequencyConfidence(medicine)) * 1000) / 1000;
}

/**
 * One `medications` row per extracted medicine. `salt` and `drug_id` stay null: they are filled by
 * the catalog match in M8. Low-confidence medicines are saved (the user was told about them) but
 * inactive, so reminders (M10) and interaction checks (M11) never use a guess.
 */
export function mapMedications(
  extraction: PrescriptionExtraction,
  clock: ClockTimes,
  now: Date,
  /**
   * M11: the salt the interaction checker actually used for medicine `i` (from its report). It is the
   * ONLY source of `salt_key`: a weak catalog match must never feed a later safety check.
   */
  interactionSalts: ReadonlyMap<number, string> = new Map(),
): MedicationRow[] {
  const start = todayInIndia(now);
  return (extraction.medicines ?? []).map((medicine, index) => {
    const durationDays = medicine.duration_days.value ?? null;
    return {
      rawName: medicine.name.value ?? medicine.raw_text.value ?? 'unreadable',
      strength: medicine.strength.value ?? null,
      form: medicine.form.value ?? null,
      dose: medicine.dose.value ?? null,
      frequencyPerDay: medicine.as_needed ? null : (medicine.frequency_per_day.value ?? null),
      asNeeded: medicine.as_needed,
      timings: toClockTimes(medicine.timings.value, clock),
      relationToFood: medicine.relation_to_food.value ?? 'any',
      durationDays,
      startDate: start,
      endDate: endDateFor(start, durationDays),
      confidence: medicineConfidence(medicine),
      active: !medicine.low_confidence,
      ...matchFields(medicine.match),
      saltKey: interactionSalts.get(index) ?? null,
    };
  });
}
