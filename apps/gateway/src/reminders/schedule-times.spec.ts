import { applyCustomTimes, defaultTimes, exclusionReason, timesFor } from './schedule-times';

const CONFIG = { morning: '08:00', afternoon: '14:00', evening: '18:00', night: '21:00' };
const med = (
  over: Partial<Parameters<typeof timesFor>[0]> = {},
): Parameters<typeof timesFor>[0] => ({
  active: true,
  asNeeded: false,
  frequencyPerDay: 2,
  timings: [],
  ...over,
});

describe('default times', () => {
  it.each([
    [1, ['08:00']],
    [2, ['08:00', '21:00']],
    [3, ['08:00', '14:00', '21:00']],
    [4, ['08:00', '14:00', '18:00', '21:00']],
  ])('%i a day -> %j', (frequency, expected) => {
    expect(defaultTimes(frequency, CONFIG)).toEqual(expected);
  });

  it('has no guess for 5+ a day', () => {
    expect(defaultTimes(5, CONFIG)).toBeNull();
  });
});

describe('eligibility', () => {
  it('SOS medicines get no reminder', () => {
    expect(exclusionReason(med({ asNeeded: true, frequencyPerDay: null }))).toBe('as_needed');
  });
  it('inactive (low-confidence) medicines get no reminder', () => {
    expect(exclusionReason(med({ active: false }))).toBe('not_active');
  });
  it('a medicine without a frequency gets none', () => {
    expect(exclusionReason(med({ frequencyPerDay: null }))).toBe('no_frequency');
    expect(exclusionReason(med({ frequencyPerDay: 0 }))).toBe('no_frequency');
  });
  it('more than 4 a day without written times gets none', () => {
    expect(exclusionReason(med({ frequencyPerDay: 6 }))).toBe('too_frequent');
    expect(exclusionReason(med({ frequencyPerDay: 6, timings: ['06:00', '10:00'] }))).toBeNull();
  });
  it('a normal medicine is eligible', () => {
    expect(exclusionReason(med())).toBeNull();
  });
});

describe('timesFor', () => {
  it('uses the default spread', () => {
    expect(timesFor(med({ frequencyPerDay: 2 }), CONFIG)).toEqual(['08:00', '21:00']);
  });
  it('prefers clock times written on the prescription, sorted and unique', () => {
    expect(timesFor(med({ timings: ['20:00', '07:30', '07:30'] }), CONFIG)).toEqual([
      '07:30',
      '20:00',
    ]);
  });
  it('ignores malformed written times', () => {
    expect(timesFor(med({ timings: ['25:00', 'morning'] }), CONFIG)).toEqual(['08:00', '21:00']);
  });
  it('returns null for an excluded medicine', () => {
    expect(timesFor(med({ asNeeded: true }), CONFIG)).toBeNull();
  });
});

describe('applyCustomTimes', () => {
  it('uses the first N of the user times', () => {
    expect(applyCustomTimes(1, ['07:00', '22:00'])).toEqual(['07:00']);
    expect(applyCustomTimes(2, ['07:00', '22:00'])).toEqual(['07:00', '22:00']);
  });
  it('cannot cover more doses than times given', () => {
    expect(applyCustomTimes(3, ['07:00', '22:00'])).toBeNull();
  });
});
