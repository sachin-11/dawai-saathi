import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.constants';
import type { Env } from '../../config/env.schema';
import { decryptText, encryptText, hashPhone, parseKey } from './crypto.util';
import { normalisePhone } from './phone';

/** Phone-number protection (CLAUDE.md §2.6, §12): hashed for lookup, encrypted for sending. */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly pepper: string;

  constructor(@Inject(APP_CONFIG) env: Env) {
    this.key = parseKey(env.ENCRYPTION_KEY);
    this.pepper = env.PHONE_HASH_PEPPER;
  }

  normalisePhone(phone: string): string {
    return normalisePhone(phone);
  }

  hashPhone(phone: string): string {
    return hashPhone(phone, this.pepper);
  }

  encrypt(plaintext: string): string {
    return encryptText(plaintext, this.key);
  }

  decrypt(payload: string): string {
    return decryptText(payload, this.key);
  }
}
