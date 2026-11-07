import { redactText } from './redact';

describe('redactText', () => {
  it.each([
    ['9876543210', '[REDACTED_PHONE]'],
    ['+91 98765 43210', '[REDACTED_PHONE]'],
    ['+919876543210', '[REDACTED_PHONE]'],
    ['91-98765-43210', '[REDACTED_PHONE]'],
    ['09876543210', '[REDACTED_PHONE]'],
    ['98765 43210', '[REDACTED_PHONE]'],
  ])('redacts the phone number %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    ['2345 6789 0123', '[REDACTED_AADHAAR]'],
    ['234567890123', '[REDACTED_AADHAAR]'],
    ['2345-6789-0123', '[REDACTED_AADHAAR]'],
  ])('redacts the Aadhaar-like number %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('redacts emails', () => {
    expect(redactText('mail me at ramesh.k+rx@example.co.in please')).toBe(
      'mail me at [REDACTED_EMAIL] please',
    );
  });

  it('redacts 6-digit PIN codes', () => {
    expect(redactText('Pune 411001')).toBe('Pune [REDACTED_PIN]');
  });

  it('redacts several identifiers in one message', () => {
    const input = 'Call 9876543210 or ramesh@mail.com, PIN 560001, aadhaar 2345 6789 0123';
    expect(redactText(input)).toBe(
      'Call [REDACTED_PHONE] or [REDACTED_EMAIL], PIN [REDACTED_PIN], aadhaar [REDACTED_AADHAAR]',
    );
  });

  it.each([
    'Dolo 650 twice a day after food',
    'Take 1 tablet at 08:00 and 20:00 for 5 days',
    'HbA1c 7.2 and sugar 126',
    'Hindi: दवाई कब लेनी है?',
    'BP 140/90, pulse 82',
  ])('leaves ordinary text alone: %s', (input) => {
    expect(redactText(input)).toBe(input);
  });

  it('never leaves the original number in the output', () => {
    expect(redactText('my number is +91 98765 43210')).not.toMatch(/9876|43210/);
  });

  it('is idempotent', () => {
    const once = redactText('9876543210 and 411001');
    expect(redactText(once)).toBe(once);
  });
});
