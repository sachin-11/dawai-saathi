import { isClockTime } from './clock';

export type TimeParseFailure = 'empty' | 'ambiguous' | 'invalid' | 'too_many';
export type TimeParseResult =
  { ok: true; times: string[] } | { ok: false; reason: TimeParseFailure };

export const MAX_CUSTOM_TIMES = 6;

type Period = 'am' | 'pm' | 'afternoon' | 'evening' | 'night';

const WORD_PERIOD: ReadonlyMap<string, Period> = new Map<string, Period>([
  ['subah', 'am'],
  ['savere', 'am'],
  ['sawere', 'am'],
  ['morning', 'am'],
  ['सुबह', 'am'],
  ['सवेरे', 'am'],
  ['dopahar', 'afternoon'],
  ['dophar', 'afternoon'],
  ['afternoon', 'afternoon'],
  ['दोपहर', 'afternoon'],
  ['shaam', 'evening'],
  ['sham', 'evening'],
  ['evening', 'evening'],
  ['शाम', 'evening'],
  ['raat', 'night'],
  ['night', 'night'],
  ['रात', 'night'],
]);

/** Words around a time that carry no meaning for us ("raat ko 10 baje"). */
const FILLER = new Set([
  'baje',
  'bje',
  'bajey',
  'बजे',
  'at',
  'ko',
  'ka',
  'ke',
  'time',
  'set',
  'karo',
  'kar',
  'do',
  'reminder',
  'around',
  'clock',
  'oclock',
]);

const SEPARATOR = /[,;&+\n]|\band\b|\baur\b|और/giu;

function toTime(hours: number, minutes: number): string {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Hour on a 24 h clock for a written hour plus a day-part, or null when it cannot be right. */
function applyPeriod(hour: number, period: Period): number | null {
  if (hour > 12) return null;
  switch (period) {
    case 'am':
      return hour === 12 ? 0 : hour;
    case 'pm':
      return hour === 12 ? 12 : hour + 12;
    case 'afternoon':
      return hour === 12 ? 12 : hour <= 6 ? hour + 12 : hour;
    case 'evening':
      return hour === 12 ? 12 : hour + 12;
    case 'night':
      // "raat 10" = 22:00, "raat 12" = 00:00, "raat 2" = 02:00.
      return hour === 12 ? 0 : hour <= 4 ? hour : hour + 12;
  }
}

type SegmentResult = { time: string } | { failure: TimeParseFailure };

function parseSegment(raw: string): SegmentResult | null {
  const text = raw
    .toLowerCase()
    // "7am" -> "7 am", "10:30pm" -> "10:30 pm"
    .replace(
      /(\d)\s*(a\.m\.|p\.m\.|am|pm)/g,
      (_m, digit: string, mark: string) => `${digit} ${mark.replaceAll('.', '')}`,
    )
    .replace(/[^\p{L}\p{N}\p{M}:.\s]/gu, ' ');
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;

  let period: Period | null = null;
  let number: RegExpExecArray | null = null;
  let unknownWords = 0;
  for (const word of words) {
    const digits = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(word);
    if (digits) {
      if (number) return { failure: 'invalid' };
      number = digits;
    } else if (word === 'am' || word === 'pm') {
      period = word;
    } else if (WORD_PERIOD.has(word)) {
      period = WORD_PERIOD.get(word) ?? null;
    } else if (!FILLER.has(word)) {
      unknownWords += 1;
    }
  }
  // No number, or words we do not understand ("kal 7 baje dawai"): ask again instead of guessing.
  if (!number || unknownWords > 0) return { failure: 'invalid' };

  const hour = Number(number[1]);
  const minutes = number[2] === undefined ? 0 : Number(number[2]);
  if (minutes > 59) return { failure: 'invalid' };

  let hour24: number | null;
  if (period) {
    hour24 = applyPeriod(hour, period);
  } else if (hour > 12 || hour === 0 || number[0].includes(':')) {
    // 24 h clock ("21", "18:30", "08:00"): the hour is taken as written.
    hour24 = hour <= 23 ? hour : null;
  } else {
    return { failure: 'ambiguous' };
  }
  if (hour24 === null) return { failure: 'invalid' };
  return { time: toTime(hour24, minutes) };
}

/**
 * Deterministic parser for the "Time badlo" answer (no LLM): `subah 7, raat 10`, `7am 10pm`,
 * `8:30 and 21:00`, `7 baje subah aur 9 baje raat`, `08:00, 20:00`. A bare hour up to 12 without a
 * day-part is ambiguous and rejected, so the bot asks again instead of guessing AM or PM.
 */
export function parseCustomTimes(text: string): TimeParseResult {
  // "7am 10pm" has no separator: split before a time that follows am/pm.
  const prepared = text.replace(/(\d\s*(?:a\.m\.|p\.m\.|am|pm))\s+(?=\d)/gi, '$1, ');
  const parsed = prepared
    .split(SEPARATOR)
    .map((part) => parseSegment(part))
    .filter((segment): segment is SegmentResult => segment !== null);
  if (parsed.length === 0) return { ok: false, reason: 'empty' };

  const times: string[] = [];
  let ambiguous = false;
  for (const segment of parsed) {
    if ('failure' in segment) {
      if (segment.failure === 'ambiguous') ambiguous = true;
      else return { ok: false, reason: segment.failure };
    } else {
      times.push(segment.time);
    }
  }
  if (ambiguous) return { ok: false, reason: 'ambiguous' };

  const unique = [...new Set(times)].sort();
  if (unique.length > MAX_CUSTOM_TIMES) return { ok: false, reason: 'too_many' };
  if (!unique.every(isClockTime)) return { ok: false, reason: 'invalid' };
  return { ok: true, times: unique };
}
