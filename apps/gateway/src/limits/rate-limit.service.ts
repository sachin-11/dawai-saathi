import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import type { MessageKey } from '../messaging/i18n/i18n.service';
import { MetricsService } from '../telemetry/metrics.service';
import { WINDOW_STORE } from './limits.constants';
import type { WindowStore } from './sliding-window';

export type LimitScope = 'msg_min' | 'msg_day' | 'docs_day' | 'voice_day' | 'caregiver_invites';
export type MessageKind = 'text' | 'document' | 'voice';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
export const LIMIT_WINDOW_MS: Readonly<Record<LimitScope, number>> = {
  msg_min: MINUTE_MS,
  msg_day: DAY_MS,
  docs_day: DAY_MS,
  voice_day: DAY_MS,
  caregiver_invites: DAY_MS,
};

/** The notice for each scope (all in i18n; every one also names 112/108). */
export const LIMIT_NOTICE: Readonly<Record<LimitScope, MessageKey>> = {
  msg_min: 'rate_limit.minute',
  msg_day: 'rate_limit.day',
  docs_day: 'rate_limit.docs',
  voice_day: 'rate_limit.voice',
  caregiver_invites: 'rate_limit.day',
};

export type LimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      scope: LimitScope;
      /** True for the FIRST limited message of this window: send the notice. Later ones are silent. */
      notify: boolean;
      retryAfterMs: number;
      /** True when this limited window tipped the user over the abuse threshold. */
      blocked: boolean;
    };

/**
 * Per-user limits (M15): sliding windows in Redis, one friendly notice per window, then silence.
 * Emergencies, DELETE and HELP never reach this class (the router handles them first).
 *
 * Abuse signal: every NEW limited window counts for the user's local day; more than
 * RL_BLOCK_AFTER_WINDOWS of them blocks the user for RL_BLOCK_HOURS (one notice, operator can unblock).
 * Fail-open: when Redis is down the message is allowed (the AI cost guard and the queue still apply).
 */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(WINDOW_STORE) private readonly store: WindowStore,
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG)
    private readonly env: Pick<
      Env,
      | 'RL_MSG_PER_MIN'
      | 'RL_MSG_PER_DAY'
      | 'RL_DOCS_PER_DAY'
      | 'RL_VOICE_PER_DAY'
      | 'RL_CAREGIVER_INVITES_PER_DAY'
      | 'RL_BLOCK_AFTER_WINDOWS'
      | 'RL_BLOCK_HOURS'
    >,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RateLimitService.name);
  }

  limitOf(scope: LimitScope): number {
    return {
      msg_min: this.env.RL_MSG_PER_MIN,
      msg_day: this.env.RL_MSG_PER_DAY,
      docs_day: this.env.RL_DOCS_PER_DAY,
      voice_day: this.env.RL_VOICE_PER_DAY,
      caregiver_invites: this.env.RL_CAREGIVER_INVITES_PER_DAY,
    }[scope];
  }

  private scopesFor(kind: MessageKind): LimitScope[] {
    const scopes: LimitScope[] = ['msg_min', 'msg_day'];
    if (kind === 'document') scopes.push('docs_day');
    if (kind === 'voice') scopes.push('voice_day');
    return scopes;
  }

  /** Count one message of `kind` for `userId` and say whether it may be processed. */
  async checkMessage(
    userId: string,
    kind: MessageKind,
    now: number = Date.now(),
    messageId?: string,
  ): Promise<LimitDecision> {
    return this.check(userId, this.scopesFor(kind), now, messageId);
  }

  /** Count one caregiver invitation (3 a day by default). */
  async checkCaregiverInvite(userId: string, now: number = Date.now()): Promise<LimitDecision> {
    return this.check(userId, ['caregiver_invites'], now);
  }

  private async check(
    userId: string,
    scopes: LimitScope[],
    now: number,
    messageId?: string,
  ): Promise<LimitDecision> {
    try {
      for (const scope of scopes) {
        const result = await this.store.hit(
          `rl:${scope}:${userId}`,
          this.limitOf(scope),
          LIMIT_WINDOW_MS[scope],
          now,
          messageId,
        );
        if (result.allowed) continue;
        return await this.limited(userId, scope, result.retryAfterMs, now);
      }
      return { allowed: true };
    } catch (error) {
      this.logger.warn({ error: (error as Error).name }, 'rate limiter unavailable, allowing');
      return { allowed: true };
    }
  }

  private async limited(
    userId: string,
    scope: LimitScope,
    retryAfterMs: number,
    now: number,
  ): Promise<LimitDecision> {
    this.metrics.rateLimited.inc({ scope });
    const notify = await this.store.once(`rl:notice:${scope}:${userId}`, LIMIT_WINDOW_MS[scope]);
    let blocked = false;
    if (notify) {
      // A new limited window: the abuse counter for this local day.
      const day = DateTime.fromMillis(now, { zone: 'Asia/Kolkata' }).toISODate() ?? 'day';
      const windows = await this.store.bump(`rl:windows:${userId}:${day}`, 2 * 24 * 3600);
      if (windows > this.env.RL_BLOCK_AFTER_WINDOWS) {
        await this.block(userId, 'rate_limit', now);
        blocked = true;
      }
    }
    return { allowed: false, scope, notify, retryAfterMs, blocked };
  }

  /** Block a user for RL_BLOCK_HOURS (or `hours`). Audited, counted, reversible with `unblock`. */
  async block(
    userId: string,
    reason: 'rate_limit' | 'media_spam' | 'operator',
    now: number = Date.now(),
    hours: number = this.env.RL_BLOCK_HOURS,
  ): Promise<void> {
    const until = new Date(now + hours * 3600_000);
    // Only an unblocked (or expired) user can be blocked: a second trigger changes nothing.
    const changed = await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ blockedUntil: null }, { blockedUntil: { lte: new Date(now) } }] },
      data: { blockedUntil: until, blockReason: reason },
    });
    if (changed.count === 0) return;
    this.metrics.userBlocked.inc({ reason });
    await this.audit.log({
      actor: reason === 'operator' ? 'admin' : 'system',
      userId,
      action: 'user_blocked',
      metadata: { reason, hours },
    });
    this.logger.warn({ event: 'user_blocked', user_id: userId, reason }, 'user blocked');
  }

  async unblock(userId: string, actor: 'admin' = 'admin'): Promise<boolean> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, blockedUntil: { not: null } },
      data: { blockedUntil: null, blockReason: null },
    });
    if (result.count > 0) {
      await this.audit.log({ actor, userId, action: 'user_unblocked' });
    }
    return result.count > 0;
  }

  /** One "you used your share" notice per 6 hours (the per-user cost cap). */
  costCapNotice(userId: string): Promise<boolean> {
    return this.store.once(`rl:notice:cost_user:${userId}`, 6 * 3600_000);
  }

  /** One "you are blocked" notice per block (marker lives as long as the block). */
  noticeForBlock(userId: string, until: Date, now: number = Date.now()): Promise<boolean> {
    return this.store.once(`rl:blocknotice:${userId}`, Math.max(1000, until.getTime() - now));
  }
}
