import { parseAckText, parseReminderButton, reminderButtonId } from './ack-parser';

describe('parseAckText', () => {
  it.each([
    ['le li', 'taken'],
    ['Le Li!', 'taken'],
    ['li', 'taken'],
    ['kha li', 'taken'],
    ['done', 'taken'],
    ['taken', 'taken'],
    ['ha', 'taken'],
    ['haan 🙏', 'taken'],
    ['✅', 'taken'],
    ['  ✅✅ ', 'taken'],
    ['ले ली', 'taken'],
    ['baad me', 'snooze'],
    ['Baad mein', 'snooze'],
    ['later', 'snooze'],
    ['skip', 'skip'],
    ['nahi', 'skip'],
  ])('%s -> %s', (text, expected) => {
    expect(parseAckText(text)).toBe(expected);
  });

  it.each([
    'ha mujhe ek sawal hai',
    'I have taken it but feel dizzy',
    'dolo kab leni hai',
    'hello',
    '',
    '   ',
  ])('does not treat %j as an ack', (text) => {
    expect(parseAckText(text)).toBeNull();
  });
});

describe('reminder button ids', () => {
  it('round-trips and stays far below the 256-character limit', () => {
    const id = reminderButtonId('snooze', 1_799_900_000);
    expect(id).toBe('rem:snooze:1799900000');
    expect(id.length).toBeLessThan(40);
    expect(parseReminderButton(id)).toEqual({ kind: 'snooze', epoch: 1_799_900_000 });
  });

  it.each([
    'rem:taken:abc',
    'rem:other:1799900000',
    'rem:taken:1799900000:x',
    'rx:wrong:1',
    'rem:taken:12',
  ])('rejects %s', (id) => {
    expect(parseReminderButton(id)).toBeNull();
  });
});
