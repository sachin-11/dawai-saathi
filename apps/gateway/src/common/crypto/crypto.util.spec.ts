import { randomBytes } from 'node:crypto';

import { CryptoError, decryptText, encryptText, hashPhone, parseKey } from './crypto.util';
import { InvalidPhoneError, normalisePhone } from './phone';

const key = randomBytes(32);

describe('normalisePhone', () => {
  it.each([
    '+91 98765 43210',
    '91 98765 43210',
    '919876543210',
    '9876543210',
    '09876543210',
    '+91-98765-43210',
    '(+91) 98765 43210',
  ])('normalises %s to 919876543210', (input) => {
    expect(normalisePhone(input)).toBe('919876543210');
  });

  it('keeps non-Indian numbers as given (digits only)', () => {
    expect(normalisePhone('+1 (415) 555-0100')).toBe('14155550100');
  });

  it.each(['', 'abc', '12345', '1234567890123456'])('rejects %p', (input) => {
    expect(() => normalisePhone(input)).toThrow(InvalidPhoneError);
  });

  it('does not put the number in the error message', () => {
    try {
      normalisePhone('123');
    } catch (error) {
      expect((error as Error).message).not.toContain('123');
    }
  });
});

describe('hashPhone', () => {
  it('is a deterministic 64-char hex string', () => {
    const hash = hashPhone('919876543210', 'pepper-1');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPhone('919876543210', 'pepper-1')).toBe(hash);
  });

  it('gives the same hash for every spelling of the same number', () => {
    const expected = hashPhone('919876543210', 'pepper-1');
    for (const spelling of ['+91 98765 43210', '91 98765 43210', '9876543210']) {
      expect(hashPhone(spelling, 'pepper-1')).toBe(expected);
    }
  });

  it('gives a different hash for a different pepper', () => {
    expect(hashPhone('919876543210', 'pepper-1')).not.toBe(hashPhone('919876543210', 'pepper-2'));
  });

  it('gives a different hash for a different number', () => {
    expect(hashPhone('919876543210', 'p')).not.toBe(hashPhone('919876543211', 'p'));
  });

  it('does not contain the number', () => {
    expect(hashPhone('919876543210', 'p')).not.toContain('9876543210');
  });
});

describe('encryptText / decryptText', () => {
  it('round-trips unicode text', () => {
    const plaintext = '919876543210 — दवाई साथी';
    expect(decryptText(encryptText(plaintext, key), key)).toBe(plaintext);
  });

  it('uses the versioned format v1:<iv>:<tag>:<ciphertext>', () => {
    const payload = encryptText('x', key);
    const parts = payload.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1] ?? '', 'base64')).toHaveLength(12); // IV
    expect(Buffer.from(parts[2] ?? '', 'base64')).toHaveLength(16); // auth tag
  });

  it('uses a fresh random IV: same plaintext encrypts differently each time', () => {
    expect(encryptText('same', key)).not.toBe(encryptText('same', key));
  });

  it('does not contain the plaintext', () => {
    expect(encryptText('919876543210', key)).not.toContain('919876543210');
  });

  const tamper = (payload: string, index: number): string => {
    const parts = payload.split(':');
    const bytes = Buffer.from(parts[index] ?? '', 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    parts[index] = bytes.toString('base64');
    return parts.join(':');
  };

  it.each([
    ['iv', 1],
    ['tag', 2],
    ['ciphertext', 3],
  ])('detects a tampered %s', (_name, index) => {
    const payload = encryptText('secret', key);
    expect(() => decryptText(tamper(payload, index), key)).toThrow(CryptoError);
  });

  it('rejects the wrong key', () => {
    const payload = encryptText('secret', key);
    expect(() => decryptText(payload, randomBytes(32))).toThrow(CryptoError);
  });

  it.each(['', 'garbage', 'v2:a:b:c', 'v1:a:b', 'v1:AAAA:AAAA:AAAA'])(
    'rejects malformed payload %p',
    (payload) => {
      expect(() => decryptText(payload, key)).toThrow(CryptoError);
    },
  );
});

describe('parseKey', () => {
  it('accepts base64 for exactly 32 bytes', () => {
    expect(parseKey(randomBytes(32).toString('base64'))).toHaveLength(32);
  });

  it('rejects other lengths without echoing the key', () => {
    const bad = randomBytes(16).toString('base64');
    expect(() => parseKey(bad)).toThrow(CryptoError);
    try {
      parseKey(bad);
    } catch (error) {
      expect((error as Error).message).not.toContain(bad);
    }
  });
});
