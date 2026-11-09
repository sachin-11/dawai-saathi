import { Inject, Injectable, Optional } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { MetricsService } from '../telemetry/metrics.service';

import { PrismaService } from '../common/prisma/prisma.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { OutboundService } from '../messaging/outbound.service';
import { epochSeconds } from './clock';
import { LATE_GRACE_MS, MISSED_MARGIN_MS } from './reminders.constants';
import { ReminderMessages } from './reminder-messages';
import { ReminderQueue } from './reminder.queue';

export type SlotOutcome = 'sent' | 'user_gone' | 'disabled' | 'nothing_pending' | 'too_late';

/**
 * What the `reminders` worker does for a slot, a missed-check and a snooze. The DATABASE is the source
 * of truth, never the job payload: every handler re-reads the user, the schedule and the rows, so a
 * stale job (user paused, deleted, already answered, job delivered twice) does nothing.
 */
@Injectable()
export class ReminderDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundService,
    private readonly queue: ReminderQueue,
    private readonly messages: ReminderMessages,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.logger.setContext(ReminderDispatchService.name);
  }

  /**
   * Send ONE grouped message for every medicine due at `scheduledAt`.
   * `attempt` > 0 means a snooze came back: only rows in `snoozed` are re-sent.
   */
  async sendSlot(
    userId: string,
    scheduledAt: Date,
    now: Date = new Date(),
    attempt = 0,
  ): Promise<SlotOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        language: true,
        remindersEnabled: true,
        deletedAt: true,
        timezone: true,
        onboardingStep: true,
      },
    });
    if (!user || user.deletedAt || user.onboardingStep !== 'done') return 'user_gone';

    const statuses = attempt > 0 ? (['snoozed'] as const) : (['pending'] as const);
    const rows = await this.prisma.reminder.findMany({
      where: {
        userId,
        scheduledAt,
        status: { in: [...statuses] },
        schedule: { status: 'active' },
        medication: { active: true },
      },
      select: {
        id: true,
        medication: { select: { rawName: true, dose: true, relationToFood: true } },
      },
      orderBy: { medication: { rawName: 'asc' } },
    });
    if (rows.length === 0) return 'nothing_pending';
    const ids = rows.map((row) => row.id);

    if (!user.remindersEnabled) {
      await this.prisma.reminder.updateMany({
        where: { id: { in: ids } },
        data: { status: 'cancelled' },
      });
      return 'disabled';
    }
    if (attempt === 0 && now.getTime() - scheduledAt.getTime() > LATE_GRACE_MS) {
      await this.prisma.reminder.updateMany({
        where: { id: { in: ids }, status: 'pending' },
        data: { status: 'missed' },
      });
      return 'too_late';
    }

    const epoch = epochSeconds(scheduledAt);
    // Enqueue FIRST, mark `sent` second: a crash in between re-enqueues the same outbound job id
    // (a no-op), so the user gets one message; marking first could lose the reminder.
    await this.outbound.enqueue(
      userId,
      this.messages.slotRequest({
        language: user.language,
        timezone: user.timezone,
        scheduledAt,
        medicines: rows.map((row) => ({
          name: row.medication.rawName,
          dose: row.medication.dose,
          food: row.medication.relationToFood,
        })),
        sourceMessageId: `rem_${userId}_${epoch}`,
        replyIndex: attempt,
      }),
    );
    await this.prisma.reminder.updateMany({
      where: { id: { in: ids }, status: { in: [...statuses] } },
      data: { status: 'sent', sentAt: now },
    });
    this.metrics?.remindersSent.inc();
    if (attempt === 0) {
      this.metrics?.reminderLag.observe(Math.max(0, now.getTime() - scheduledAt.getTime()));
    }
    await this.queue.addMissed(
      userId,
      scheduledAt,
      new Date(now.getTime() + this.env.REMINDER_ACK_TIMEOUT_MIN * 60_000),
      attempt,
      now,
    );
    return 'sent';
  }

  /**
   * `sent` for REMINDER_ACK_TIMEOUT_MIN without an answer -> `missed`. Counted ONCE per slot (not per
   * medicine) in `users.consecutive_misses`; reaching CAREGIVER_ALERT_AFTER_MISSES queues the alert.
   * `snoozed` rows are left alone: the user asked to be reminded later.
   */
  async checkMissed(
    userId: string,
    scheduledAt: Date,
    now: Date = new Date(),
  ): Promise<{ missed: number; consecutiveMisses: number | null; alerted: boolean }> {
    const cutoff = new Date(
      now.getTime() - (this.env.REMINDER_ACK_TIMEOUT_MIN * 60_000 - MISSED_MARGIN_MS),
    );
    const result = await this.prisma.reminder.updateMany({
      where: { userId, scheduledAt, status: 'sent', sentAt: { lte: cutoff } },
      data: { status: 'missed' },
    });
    if (result.count === 0) return { missed: 0, consecutiveMisses: null, alerted: false };
    this.metrics?.reminderAck.inc({ status: 'missed' }, result.count);

    const updated = await this.prisma.user.updateMany({
      where: { id: userId },
      data: { consecutiveMisses: { increment: 1 } },
    });
    if (updated.count === 0)
      return { missed: result.count, consecutiveMisses: null, alerted: false };
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { consecutiveMisses: true },
    });
    const misses = user?.consecutiveMisses ?? 0;
    let alerted = false;
    if (misses >= this.env.CAREGIVER_ALERT_AFTER_MISSES) {
      await this.queue.addAlert(userId, scheduledAt, now);
      alerted = true;
    }
    return { missed: result.count, consecutiveMisses: misses, alerted };
  }
}
