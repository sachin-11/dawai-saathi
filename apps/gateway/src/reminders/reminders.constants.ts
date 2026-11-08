const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A slot more than this late when the planner/worker sees it is marked missed silently, never sent. */
export const LATE_GRACE_MS = 10 * MINUTE;
/** A text answer ("le li") counts for the latest reminder sent within this time. */
export const TEXT_ACK_WINDOW_MS = 2 * HOUR;
/** "Le li" after the dose was marked missed still counts (as a late dose) within this time. */
export const LATE_ACK_WINDOW_MS = 6 * HOUR;
export const MAX_SNOOZES = 2;
/** Safety margin when the missed-checker compares `sent_at` with its deadline. */
export const MISSED_MARGIN_MS = 30 * 1000;

/** Caregiver invites expire after this. */
export const INVITE_TTL_MS = 48 * HOUR;
/** At most one alert per caregiver per this long, and MAX_ALERTS_PER_DAY per local day. */
export const ALERT_MIN_GAP_MS = 6 * HOUR;
export const MAX_ALERTS_PER_DAY = 3;
export const MAX_ACTIVE_CAREGIVERS = 2;

export const REMINDER_ACTIVE_STATUSES = ['pending', 'sent', 'snoozed'] as const;
