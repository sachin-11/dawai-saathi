import { parseCustomTimes } from './time-parser';

describe('parseCustomTimes', () => {
  it.each<[string, string[]]>([
    // Hinglish with day-parts
    ['subah 7, raat 10', ['07:00', '22:00']],
    ['Subah 7 aur raat 10', ['07:00', '22:00']],
    ['7 baje subah aur 9 baje raat', ['07:00', '21:00']],
    ['subah 8:30, dopahar 2, shaam 6, raat 9', ['08:30', '14:00', '18:00', '21:00']],
    ['raat 12', ['00:00']],
    ['raat 2', ['02:00']],
    ['dopahar 12', ['12:00']],
    ['shaam 7:15', ['19:15']],
    // English
    ['7am 10pm', ['07:00', '22:00']],
    ['7 am, 10 pm', ['07:00', '22:00']],
    ['7:30 AM and 9:45 PM', ['07:30', '21:45']],
    ['12am', ['00:00']],
    ['12pm', ['12:00']],
    ['morning 8, night 9', ['08:00', '21:00']],
    // 24 h clock
    ['08:00, 20:00', ['08:00', '20:00']],
    ['21', ['21:00']],
    ['8:30', ['08:30']],
    ['18:30 and 06:30', ['06:30', '18:30']],
    // Devanagari
    ['सुबह 7, रात 10', ['07:00', '22:00']],
    ['सुबह 8 बजे और शाम 6 बजे', ['08:00', '18:00']],
    // duplicates collapse, order is sorted
    ['raat 10, subah 7, subah 7', ['07:00', '22:00']],
  ])('%s -> %j', (text, expected) => {
    expect(parseCustomTimes(text)).toEqual({ ok: true, times: expected });
  });

  it.each<[string, string]>([
    ['', 'empty'],
    ['   ', 'empty'],
    ['7, 10', 'ambiguous'],
    ['subah 7, 10', 'ambiguous'],
    ['8', 'ambiguous'],
    ['dawai kab leni hai', 'invalid'],
    ['subah 25', 'invalid'],
    ['subah 13', 'invalid'],
    ['25:00', 'invalid'],
    ['8:75', 'invalid'],
    ['kal 7 baje dawai', 'invalid'],
    ['subah', 'invalid'],
    ['1, 2, 3, 4, 5, 6, 7 pm', 'ambiguous'],
    ['7am, 8am, 9am, 10am, 11am, 12pm, 1pm', 'too_many'],
  ])('rejects %j (%s)', (text, reason) => {
    expect(parseCustomTimes(text)).toEqual({ ok: false, reason });
  });
});
