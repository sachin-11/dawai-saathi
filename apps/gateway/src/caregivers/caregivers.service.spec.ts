import { cleanLabel, isIndianMobile } from './caregivers.service';

describe('cleanLabel', () => {
  it.each([
    ['Papa', 'Papa'],
    ['  Mummy  ', 'Mummy'],
    ['Dadaji', 'Dadaji'],
    ['पापा', 'पापा'],
    ['Bade  Bhaiya', 'Bade Bhaiya'],
    ["Ma'am", "Ma'am"],
  ])('%p -> %p', (input, expected) => {
    expect(cleanLabel(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    '9876543210', // a phone number is never a label
    'Papa 2',
    'a'.repeat(21),
    'papa@example.com',
    'Papa\nMummy'.replace('\n', '1'),
    '12',
    '<b>',
  ])('rejects %p', (input) => {
    expect(cleanLabel(input)).toBeNull();
  });
});

describe('isIndianMobile', () => {
  it.each(['919876543210', '916000000000', '917999999999'])('accepts %s', (number) => {
    expect(isIndianMobile(number)).toBe(true);
  });
  it.each(['915876543210', '91987654321', '9198765432101', '447911123456', '9876543210', ''])(
    'rejects %p',
    (number) => {
      expect(isIndianMobile(number)).toBe(false);
    },
  );
});
