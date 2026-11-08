import { DateTime } from 'luxon';

/** India has no DST, but nothing below assumes that: every conversion goes through the zone. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isClockTime(value: string): boolean {
  return CLOCK_TIME.test(value);
}

/** `YYYY-MM-DD` of an instant on the wall clock of `timezone`. */
export function localDateOf(instant: Date, timezone: string): string {
  const date = DateTime.fromJSDate(instant, { zone: timezone }).toISODate();
  if (date === null) throw new Error('invalid instant or timezone');
  return date;
}

/** `YYYY-MM-DD` of a Prisma `@db.Date` value (UTC midnight). */
export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Prisma `@db.Date` value for a `YYYY-MM-DD` string. */
export function dateFromIso(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function addDaysIso(date: string, days: number): string {
  const result = DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate();
  if (result === null) throw new Error('invalid date');
  return result;
}

/** The instant at which the wall clock of `timezone` shows `date` + `time` ("2026-11-08", "08:00"). */
export function toInstant(date: string, time: string, timezone: string): Date {
  const value = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  if (!value.isValid) throw new Error('invalid date, time or timezone');
  return value.toJSDate();
}

/** `HH:mm` on the wall clock of `timezone`. */
export function localTimeOf(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat('HH:mm');
}

export interface SlotWindow {
  /** Local wall-clock times, `HH:MM`. */
  times: readonly string[];
  timezone: string;
  /** First and last (inclusive) local day of the schedule; `endDate` null = open ended. */
  startDate: string;
  endDate: string | null;
  /** Slots with `from <= instant < to`. */
  from: Date;
  to: Date;
}

/** Every slot instant of a schedule inside a window, ascending. Pure: the caller passes the clock. */
export function slotsBetween(window: SlotWindow): Date[] {
  const { times, timezone, startDate, endDate, from, to } = window;
  const firstDay = addDaysIso(localDateOf(from, timezone), -1);
  const lastDay = addDaysIso(localDateOf(to, timezone), 1);
  const slots: Date[] = [];
  for (let day = firstDay; day <= lastDay; day = addDaysIso(day, 1)) {
    if (day < startDate || (endDate !== null && day > endDate)) continue;
    for (const time of times) {
      const instant = toInstant(day, time, timezone);
      if (instant >= from && instant < to) slots.push(instant);
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime());
}

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return hours * 60 + minutes;
}

/** Is the local time of `instant` inside [start, end)? The window may wrap midnight (22:30-06:30). */
export function inQuietHours(instant: Date, timezone: string, start: string, end: string): boolean {
  const now = minutesOfDay(localTimeOf(instant, timezone));
  const from = minutesOfDay(start);
  const until = minutesOfDay(end);
  if (from === until) return false;
  return from < until ? now >= from && now < until : now >= from || now < until;
}

/** Epoch seconds: the compact slot identity used in job ids and button ids. */
export function epochSeconds(instant: Date): number {
  return Math.floor(instant.getTime() / 1000);
}

export function fromEpochSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}
