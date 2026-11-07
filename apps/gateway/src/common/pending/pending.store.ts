import { Global, Injectable, Module } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';

export type PendingKind = 'delete';

/** How long a "really delete everything?" confirmation stays valid. */
export const PENDING_TTL_SECONDS = 300;

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
