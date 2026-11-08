import { isClockTime } from './clock';

export interface DefaultTimesConfig {
  morning: string;
  afternoon: string;
  evening: string;
  night: string;
}

/** Highest frequency that has a default spread; above it we do not guess times. */
export const MAX_DEFAULT_FREQUENCY = 4;

/**
 * Default clock times for "N times a day" (M7 mapping: morning, afternoon, evening, night):
 * 1 -> morning, 2 -> morning + night, 3 -> morning + afternoon + night, 4 -> all four.
 */
export function defaultTimes(frequencyPerDay: number, config: DefaultTimesConfig): string[] | null {
  switch (frequencyPerDay) {
    case 1:
      return [config.morning];
    case 2:
      return [config.morning, config.night];
    case 3:
      return [config.morning, config.afternoon, config.night];
    case 4:
      return [config.morning, config.afternoon, config.evening, config.night];
    default:
      return null;
  }
}

export interface ReminderMedication {
  active: boolean;
  asNeeded: boolean;
  frequencyPerDay: number | null;
  timings: readonly string[];
}

export type ExclusionReason = 'not_active' | 'as_needed' | 'no_frequency' | 'too_frequent';

/** Why a medicine gets NO reminder, or null when it does. Low-confidence items are `active=false` (M7). */
export function exclusionReason(medication: ReminderMedication): ExclusionReason | null {
  if (!medication.active) return 'not_active';
  if (medication.asNeeded) return 'as_needed';
  if (medication.frequencyPerDay === null || medication.frequencyPerDay < 1) return 'no_frequency';
  const written = medication.timings.filter(isClockTime);
  if (written.length === 0 && medication.frequencyPerDay > MAX_DEFAULT_FREQUENCY) {
    return 'too_frequent';
  }
  return null;
}

/** Times written on the prescription win; otherwise the default spread. Sorted, unique. */
export function timesFor(
  medication: ReminderMedication,
  config: DefaultTimesConfig,
): string[] | null {
  if (exclusionReason(medication) !== null) return null;
  const written = [...new Set(medication.timings.filter(isClockTime))].sort();
  if (written.length > 0) return written;
  return defaultTimes(medication.frequencyPerDay as number, config);
}

/**
 * Apply the user's own times (from "Time badlo") to a medicine that needs `frequency` doses a day:
 * the first `frequency` times are used. Fewer than `frequency` cannot cover the day, so null.
 */
export function applyCustomTimes(frequency: number, custom: readonly string[]): string[] | null {
  if (custom.length < frequency) return null;
  return custom.slice(0, frequency);
}
