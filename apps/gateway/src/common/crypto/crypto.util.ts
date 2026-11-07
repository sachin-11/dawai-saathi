import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { normalisePhone } from './phone';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // the recommended GCM nonce size
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERSION = 'v1';

export class CryptoError extends Error {
  constructor(message: string) {
    // Messages are generic on purpose: never echo key material or plaintext.
    super(message);
    this.name = 'CryptoError';
  }
}

/** Decode and check an AES-256 key given as base64. */
export function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new CryptoError('encryption key must be 32 bytes');
  }
  return key;
}

/**
 * Lookup hash of a phone number (hex). HMAC-SHA256 keyed with the secret pepper over the normalised
 * E.164 digits: deterministic (so we can find a user by number) but not reversible or guessable
 * without the pepper, even though the number space is small. Used for lookup only — to SEND we
 * decrypt `wa_phone_enc`.
 */
export function hashPhone(phone: string, pepper: string): string {
  return createHmac('sha256', pepper).update(normalisePhone(phone)).digest('hex');
}

/**
 * AES-256-GCM encryption with a fresh random IV per call.
 * Output: `v1:<iv>:<tag>:<ciphertext>` (each part base64). The version prefix lets us rotate keys
 * or algorithms later without guessing which format a stored value uses.
 */
export function encryptText(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Inverse of `encryptText`. Throws CryptoError if the payload is malformed or has been tampered with. */
export function decryptText(payload: string, key: Buffer): string {
  const parts = payload.split(':');
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (
    parts.length !== 4 ||
    version !== VERSION ||
    ivB64 === undefined ||
    tagB64 === undefined ||
    ciphertextB64 === undefined
  ) {
    throw new CryptoError('unsupported or malformed ciphertext');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError('unsupported or malformed ciphertext');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new CryptoError('decryption failed (wrong key or tampered data)');
  }
}
