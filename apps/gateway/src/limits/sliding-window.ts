import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { RedisService } from '../common/redis/redis.service';

export interface WindowResult {
  allowed: boolean;
  /** Events in the window after this call (when allowed) or before it (when not). */
  count: number;
  /** When not allowed: milliseconds until the oldest event leaves the window. */
  retryAfterMs: number;
}

/** A sliding-window counter. Redis in production, an in-memory twin in unit tests. */
export interface WindowStore {
  /**
   * Count one event. With a `member` (e.g. the message id) the call is idempotent: a retry of the
   * same event is allowed again and not counted twice.
   */
  hit(
    key: string,
    limit: number,
    windowMs: number,
    now?: number,
    member?: string,
  ): Promise<WindowResult>;
  /** Set a marker that expires after `ttlMs`. True only for the call that created it. */
  once(key: string, ttlMs: number): Promise<boolean>;
  /** Increment a counter that expires `ttlSeconds` after the FIRST increment. Returns the new value. */
  bump(key: string, ttlSeconds: number): Promise<number>;
}

// Atomic: drop events older than the window, count, and record this one only if there is room.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if redis.call('ZSCORE', key, member) then
  return {1, count, 0}
end
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then retry = tonumber(oldest[2]) + window - now end
  return {0, count, retry}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, count + 1, 0}
`;

@Injectable()
export class RedisWindowStore implements WindowStore {
  constructor(private readonly redis: RedisService) {}

  async hit(
    key: string,
    limit: number,
    windowMs: number,
    now: number = Date.now(),
    member: string = `${now}-${randomUUID()}`,
  ): Promise<WindowResult> {
    const raw = (await this.redis.client.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(now),
      String(windowMs),
      String(limit),
      member,
    )) as [number, number, number];
    return { allowed: raw[0] === 1, count: raw[1], retryAfterMs: Math.max(0, raw[2]) };
  }

  async once(key: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.client.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK';
  }

  async bump(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.redis.client.incr(key);
    if (value === 1) await this.redis.client.expire(key, ttlSeconds);
    return value;
  }
}

/** Same behaviour in memory: used by unit tests (the Lua script has its own integration test). */
export class InMemoryWindowStore implements WindowStore {
  private readonly windows = new Map<string, Map<string, number>>();
  private readonly markers = new Map<string, number>();
  private readonly counters = new Map<string, { value: number; expiresAt: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  private seq = 0;

  hit(
    key: string,
    limit: number,
    windowMs: number,
    now: number = this.clock(),
    member: string = `m${this.seq++}`,
  ): Promise<WindowResult> {
    const events = this.windows.get(key) ?? new Map<string, number>();
    for (const [id, at] of events) if (at <= now - windowMs) events.delete(id);
    this.windows.set(key, events);
    if (events.has(member))
      return Promise.resolve({ allowed: true, count: events.size, retryAfterMs: 0 });
    if (events.size >= limit) {
      const oldest = Math.min(...events.values());
      return Promise.resolve({
        allowed: false,
        count: events.size,
        retryAfterMs: Math.max(0, oldest + windowMs - now),
      });
    }
    events.set(member, now);
    return Promise.resolve({ allowed: true, count: events.size, retryAfterMs: 0 });
  }

  once(key: string, ttlMs: number): Promise<boolean> {
    const now = this.clock();
    const until = this.markers.get(key);
    if (until !== undefined && until > now) return Promise.resolve(false);
    this.markers.set(key, now + ttlMs);
    return Promise.resolve(true);
  }

  bump(key: string, ttlSeconds: number): Promise<number> {
    const now = this.clock();
    const current = this.counters.get(key);
    const live = current && current.expiresAt > now ? current : undefined;
    const value = (live?.value ?? 0) + 1;
    this.counters.set(key, { value, expiresAt: live?.expiresAt ?? now + ttlSeconds * 1000 });
    return Promise.resolve(value);
  }
}
