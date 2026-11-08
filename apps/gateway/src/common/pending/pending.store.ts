import { Global, Injectable, Module } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';

export type PendingKind =
  | 'delete'
  /** M10: "I am waiting for free text from this user" -> JSON `{kind, ref?}`. */
  | 'input'
  /** M10: the text that user sent while `input` was pending (stored ENCRYPTED, consumed once). */
  | 'input_text'
  /** M10: a caregiver phone number from `CAREGIVER +91...` (stored ENCRYPTED). */
  | 'cg_phone'
  /** M10: the user's own reminder times for one prescription -> JSON `{documentId, times}`. */
  | 'rem_plan';

/** How long a "really delete everything?" confirmation stays valid. */
export const PENDING_TTL_SECONDS = 300;
/** How long the bot waits for a free-text answer (caregiver label, new reminder times). */
export const INPUT_TTL_SECONDS = 600;

/**
 * Short-lived "waiting for the user's answer" markers in Redis: `pending:<kind>:<userId>`.
 * They expire on their own, so an old confirmation button tapped hours later cannot trigger anything.
 */
@Injectable()
export class PendingStore {
  constructor(private readonly redis: RedisService) {}

  static key(kind: PendingKind, userId: string): string {
    return `pending:${kind}:${userId}`;
  }

  async set(kind: PendingKind, userId: string, ttlSeconds = PENDING_TTL_SECONDS): Promise<void> {
    await this.redis.client.set(PendingStore.key(kind, userId), '1', 'EX', ttlSeconds);
  }

  /** Store a value (callers encrypt anything sensitive first). */
  async setValue(
    kind: PendingKind,
    userId: string,
    value: string,
    ttlSeconds = INPUT_TTL_SECONDS,
  ): Promise<void> {
    await this.redis.client.set(PendingStore.key(kind, userId), value, 'EX', ttlSeconds);
  }

  async getValue(kind: PendingKind, userId: string): Promise<string | null> {
    return this.redis.client.get(PendingStore.key(kind, userId));
  }

  async exists(kind: PendingKind, userId: string): Promise<boolean> {
    return (await this.redis.client.exists(PendingStore.key(kind, userId))) === 1;
  }

  async clear(kind: PendingKind, userId: string): Promise<void> {
    await this.redis.client.del(PendingStore.key(kind, userId));
  }

  /** Erasure: remove every `pending:*:<userId>` key. Returns how many were deleted. */
  async clearAllFor(userId: string): Promise<number> {
    const pattern = `pending:*:${userId}`;
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        deleted += await this.redis.client.del(...keys);
      }
    } while (cursor !== '0');
    return deleted;
  }
}

@Global()
@Module({ providers: [PendingStore], exports: [PendingStore] })
export class PendingModule {}
