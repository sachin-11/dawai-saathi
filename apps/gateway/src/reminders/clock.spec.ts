import {
  addDaysIso,
  epochSeconds,
  fromEpochSeconds,
  inQuietHours,
  localDateOf,
  localTimeOf,
  slotsBetween,
  toInstant,
} from './clock';

const IST = 'Asia/Kolkata';

describe('clock (Asia/Kolkata)', () => {
  it('converts local wall-clock time to UTC (IST = UTC+5:30)', () => {
    expect(toInstant('2026-11-08', '08:00', IST).toISOString()).toBe('2026-11-08T02:30:00.000Z');
    expect(toInstant('2026-11-08', '00:15', IST).toISOString()).toBe('2026-11-07T18:45:00.000Z');
  });

  it('knows the local date at the UTC day boundary', () => {
    expect(localDateOf(new Date('2026-11-07T19:00:00Z'), IST)).toBe('2026-11-08');
    expect(localDateOf(new Date('2026-11-07T18:29:00Z'), IST)).toBe('2026-11-07');
    expect(localTimeOf(new Date('2026-11-07T19:00:00Z'), IST)).toBe('00:30');
  });

  it('does not assume a fixed offset: a DST zone gives a different UTC time in summer and winter', () => {
    expect(toInstant('2026-07-01', '08:00', 'Europe/London').toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
    expect(toInstant('2026-12-01', '08:00', 'Europe/London').toISOString()).toBe(
      '2026-12-01T08:00:00.000Z',
    );
  });

  it('adds days across a month end', () => {
    expect(addDaysIso('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('round-trips epoch seconds', () => {
    const date = new Date('2026-11-08T02:30:00Z');
    expect(fromEpochSeconds(epochSeconds(date)).getTime()).toBe(date.getTime());
  });

  describe('slotsBetween', () => {
    const base = { times: ['08:00', '21:00'], timezone: IST, startDate: '2026-11-08' };

    it('lists slots in order inside [from, to)', () => {
      const slots = slotsBetween({
        ...base,
        endDate: null,
        from: new Date('2026-11-08T00:00:00Z'),
        to: new Date('2026-11-09T12:00:00Z'),
      });
      expect(slots.map((slot) => slot.toISOString())).toEqual([
        '2026-11-08T02:30:00.000Z',
        '2026-11-08T15:30:00.000Z',
        '2026-11-09T02:30:00.000Z',
      ]);
    });

    it('respects start and inclusive end dates', () => {
      const slots = slotsBetween({
        ...base,
        startDate: '2026-11-09',
        endDate: '2026-11-09',
        from: new Date('2026-11-07T00:00:00Z'),
        to: new Date('2026-11-12T00:00:00Z'),
      });
      expect(slots).toHaveLength(2);
      expect(localDateOf(slots[0] as Date, IST)).toBe('2026-11-09');
    });

    it('excludes the upper bound and includes the lower one', () => {
      const slots = slotsBetween({
        ...base,
        endDate: null,
        from: new Date('2026-11-08T02:30:00Z'),
        to: new Date('2026-11-08T15:30:00Z'),
      });
      expect(slots.map((slot) => slot.toISOString())).toEqual(['2026-11-08T02:30:00.000Z']);
    });
  });

  describe('inQuietHours (22:30-06:30, wraps midnight)', () => {
    const at = (time: string): Date => toInstant('2026-11-08', time, IST);
    it.each([
      ['22:29', false],
      ['22:30', true],
      ['23:59', true],
      ['00:00', true],
      ['06:29', true],
      ['06:30', false],
      ['12:00', false],
    ])('%s -> %s', (time, expected) => {
      expect(inQuietHours(at(time), IST, '22:30', '06:30')).toBe(expected);
    });

    it('handles a window inside one day and an empty window', () => {
      expect(inQuietHours(at('14:00'), IST, '13:00', '15:00')).toBe(true);
      expect(inQuietHours(at('15:00'), IST, '13:00', '15:00')).toBe(false);
      expect(inQuietHours(at('03:00'), IST, '00:00', '00:00')).toBe(false);
    });
  });
});
