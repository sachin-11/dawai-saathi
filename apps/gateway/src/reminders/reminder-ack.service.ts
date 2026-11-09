import { Inject, Injectable, Optional } from '@nestjs/common';

import { MetricsService } from '../telemetry/metrics.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import type { ReplySession } from '../conversation/replies.service';
import { type AckKind } from './ack-parser';
import { fromEpochSeconds, inQuietHours } from './clock';
import { LATE_ACK_WINDOW_MS, MAX_SNOOZES, TEXT_ACK_WINDOW_MS } from './reminders.constants';
import { ReminderQueue } from './reminder.queue';

export type AckOutcome =
  | 'taken'
  | 'taken_late'
  | 'skipped'
  | 'snoozed'
  | 'snooze_limit'
  | 'snooze_quiet'
  | 'already'
  | 'expired';

/**
 * The user's answer to a reminder: a button (`rem:taken:<epoch>`) or a text alias ("le li").
 * Everything is a conditional UPDATE on the current status, so double taps and retried jobs cannot
 * count a dose twice.
 */
@Injectable()
export class ReminderAckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ReminderQueue,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** The slot a plain text answer refers to: the latest reminder sent within the last 2 hours. */
  async latestOpenSlot(userId: string, now: Date = new Date()): Promise<Date | null> {
    const row = await this.prisma.reminder.findFirst({
      where: {
        userId,
        status: { in: ['sent', 'snoozed', 'missed'] },
        sentAt: { gte: new Date(now.getTime() - TEXT_ACK_WINDOW_MS) },
      },
      orderBy: { sentAt: 'desc' },
      select: { scheduledAt: true },
    });
    return row?.scheduledAt ?? null;
  }

  /** Button tap: the slot is in the id, the user is the sender (nobody can answer for someone else). */
  async handleButton(
    userId: string,
    kind: AckKind,
    epoch: number,
    session: ReplySession,
    now: Date = new Date(),
  ): Promise<AckOutcome> {
    return this.apply(userId, kind, fromEpochSeconds(epoch), session, now);
  }

  /** Text answer: returns null when no reminder is open, so the caller treats it as normal text. */
  async handleText(
    userId: string,
    kind: AckKind,
    session: ReplySession,
    now: Date = new Date(),
  ): Promise<AckOutcome | null> {
    const slot = await this.latestOpenSlot(userId, now);
    if (!slot) return null;
    return this.apply(userId, kind, slot, session, now);
  }

  private async apply(
    userId: string,
    kind: AckKind,
    slot: Date,
    session: ReplySession,
    now: Date,
  ): Promise<AckOutcome> {
    const outcome =
      kind === 'taken'
        ? await this.taken(userId, slot, now)
        : kind === 'skip'
          ? await this.skip(userId, slot, now)
          : await this.snooze(userId, slot, now);

    switch (outcome) {
      case 'taken':
      case 'taken_late':
        await session.text('reminder.ack_taken');
        break;
      case 'skipped':
        await session.text('reminder.ack_skip');
        break;
      case 'snoozed':
        await session.text('reminder.ack_snooze', { minutes: this.env.SNOOZE_MINUTES });
        break;
      case 'snooze_limit':
        await session.text('reminder.snooze_limit');
        break;
      case 'snooze_quiet':
        await session.text('reminder.snooze_quiet');
        break;
      case 'already':
        await session.text('reminder.already');
        break;
      case 'expired':
        await session.text('reminder.expired');
        break;
    }
    return outcome;
  }

  private async taken(userId: string, slot: Date, now: Date): Promise<AckOutcome> {
    const open = await this.prisma.reminder.updateMany({
      where: { userId, scheduledAt: slot, status: { in: ['sent', 'snoozed'] } },
      data: { status: 'taken', ackAt: now },
    });
    // A dose marked missed can still be confirmed for 6 hours (only if we really sent the reminder).
    const late = await this.prisma.reminder.updateMany({
      where: {
        userId,
        scheduledAt: { equals: slot, gte: new Date(now.getTime() - LATE_ACK_WINDOW_MS) },
        status: 'missed',
        sentAt: { not: null },
      },
      data: { status: 'taken', ackAt: now },
    });
    if (open.count + late.count > 0) {
      this.metrics?.reminderAck.inc({ status: 'taken' }, open.count + late.count);
      // Any taken dose ends the "missed in a row" streak.
      await this.prisma.user.updateMany({ where: { id: userId }, data: { consecutiveMisses: 0 } });
      return open.count > 0 ? 'taken' : 'taken_late';
    }
    return this.noChange(userId, slot);
  }

  private async skip(userId: string, slot: Date, now: Date): Promise<AckOutcome> {
    const result = await this.prisma.reminder.updateMany({
      where: { userId, scheduledAt: slot, status: { in: ['sent', 'snoozed'] } },
      data: { status: 'skipped', ackAt: now },
    });
    if (result.count > 0) this.metrics?.reminderAck.inc({ status: 'skipped' }, result.count);
    return result.count > 0 ? 'skipped' : this.noChange(userId, slot);
  }

  private async snooze(userId: string, slot: Date, now: Date): Promise<AckOutcome> {
    // Only a reminder that is waiting (`sent`) can be snoozed; a second tap while it is already
    // snoozed does nothing, so a double tap uses ONE of the two snoozes.
    const waiting = await this.prisma.reminder.findMany({
      where: { userId, scheduledAt: slot, status: 'sent' },
      select: { id: true, snoozeCount: true },
    });
    if (waiting.length === 0) return this.noChange(userId, slot);

    const eligible = waiting.filter((row) => row.snoozeCount < MAX_SNOOZES);
    if (eligible.length === 0) return 'snooze_limit';

    const runAt = new Date(now.getTime() + this.env.SNOOZE_MINUTES * 60_000);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true, quietHoursStart: true, quietHoursEnd: true },
    });
    // A snooze never pushes a reminder into quiet hours.
    if (user && inQuietHours(runAt, user.timezone, user.quietHoursStart, user.quietHoursEnd)) {
      return 'snooze_quiet';
    }

    const attempt = Math.max(...eligible.map((row) => row.snoozeCount)) + 1;
    const updated = await this.prisma.reminder.updateMany({
      where: { id: { in: eligible.map((row) => row.id) }, status: 'sent' },
      data: { status: 'snoozed', snoozeCount: { increment: 1 } },
    });
    if (updated.count === 0) return 'already';
    await this.queue.addSnooze(userId, slot, attempt, runAt, now);
    return 'snoozed';
  }

  /** Nothing was changed: either it was already answered (idempotent repeat) or it is not open. */
  private async noChange(userId: string, slot: Date): Promise<AckOutcome> {
    const answered = await this.prisma.reminder.count({
      where: { userId, scheduledAt: slot, status: { in: ['taken', 'skipped', 'snoozed'] } },
    });
    return answered > 0 ? 'already' : 'expired';
  }
}
