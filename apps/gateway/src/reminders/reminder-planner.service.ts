import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../common/prisma/prisma.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { I18nService } from '../messaging/i18n/i18n.service';
import { OutboundService } from '../messaging/outbound.service';
import { BUTTON_ID } from '../conversation/commands';
import {
  addDaysIso,
  DEFAULT_TIMEZONE,
  isoDate,
  localDateOf,
  localTimeOf,
  slotsBetween,
  toInstant,
} from './clock';
import { LATE_GRACE_MS } from './reminders.constants';
import { jobIds, ReminderQueue } from './reminder.queue';

export interface PlanStats {
  schedules: number;
  rowsCreated: number;
  jobsEnsured: number;
  missedSilently: number;
  completed: number;
  renewalsAsked: number;
  summariesSent: number;
}

const PAGE = 200;

/**
 * Rolling-window planner. It never creates jobs for the whole prescription: every 15 minutes (and
 * once right after a schedule is created) it makes sure the next `REMINDER_HORIZON_HOURS` exist as
 * `reminders` rows + delayed BullMQ jobs. Running it twice, or after a Redis wipe, is safe: rows are
 * unique per (schedule, time) and job ids are deterministic. Editing or pausing a schedule only has to
 * touch the next 36 hours.
 */
@Injectable()
export class ReminderPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ReminderQueue,
    private readonly outbound: OutboundService,
    private readonly i18n: I18nService,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReminderPlannerService.name);
  }

  planAll(now: Date = new Date()): Promise<PlanStats> {
    return this.plan({}, now);
  }

  planUser(userId: string, now: Date = new Date()): Promise<PlanStats> {
    return this.plan({ userId }, now);
  }

  private async plan(scope: { userId?: string }, now: Date): Promise<PlanStats> {
    const stats: PlanStats = {
      schedules: 0,
      rowsCreated: 0,
      jobsEnsured: 0,
      missedSilently: 0,
      completed: 0,
      renewalsAsked: 0,
      summariesSent: 0,
    };
    const userFilter = scope.userId ? { userId: scope.userId } : {};

    // 1. Slots nobody could send in time (server down, queue backlog): missed, silently. These never
    //    count towards the caregiver alert and never trigger a late reminder.
    const overdue = await this.prisma.reminder.updateMany({
      where: {
        ...userFilter,
        status: 'pending',
        scheduledAt: { lt: new Date(now.getTime() - LATE_GRACE_MS) },
      },
      data: { status: 'missed' },
    });
    stats.missedSilently = overdue.count;

    // 2. Materialise the horizon.
    const horizonEnd = new Date(now.getTime() + this.env.REMINDER_HORIZON_HOURS * 3_600_000);
    const windowStart = new Date(now.getTime() - LATE_GRACE_MS);
    const renewals = new Map<string, { scheduleIds: string[]; language: 'hi' | 'en' }>();

    let cursor: string | undefined;
    for (;;) {
      const schedules = await this.prisma.reminderSchedule.findMany({
        where: {
          ...userFilter,
          status: 'active',
          user: { remindersEnabled: true, deletedAt: null, onboardingStep: 'done' },
          medication: { active: true },
        },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          userId: true,
          medicationId: true,
          times: true,
          startDate: true,
          endDate: true,
          timezone: true,
          createdAt: true,
          renewalNotifiedAt: true,
          medication: { select: { durationDays: true } },
          user: { select: { language: true } },
        },
      });
      if (schedules.length === 0) break;
      cursor = schedules[schedules.length - 1]?.id;

      const rows: Prisma.ReminderCreateManyInput[] = [];
      const bySchedule = new Map<string, Date[]>();
      for (const schedule of schedules) {
        stats.schedules += 1;
        const today = localDateOf(now, schedule.timezone);
        const endDate = schedule.endDate ? isoDate(schedule.endDate) : null;

        if (endDate !== null && endDate < today) {
          await this.prisma.reminderSchedule.updateMany({
            where: { id: schedule.id, status: 'active' },
            data: { status: 'completed' },
          });
          stats.completed += 1;
          continue;
        }

        // Never before the schedule existed: a prescription set up at 10:00 has no 08:00 slot.
        const from = new Date(
          Math.max(windowStart.getTime(), schedule.createdAt.getTime() - 60_000),
        );
        for (const slot of slotsBetween({
          times: schedule.times,
          timezone: schedule.timezone,
          startDate: isoDate(schedule.startDate),
          endDate,
          from,
          to: horizonEnd,
        })) {
          bySchedule.set(schedule.id, [...(bySchedule.get(schedule.id) ?? []), slot]);
          rows.push({
            scheduleId: schedule.id,
            medicationId: schedule.medicationId,
            userId: schedule.userId,
            scheduledAt: slot,
            jobId: jobIds.slot(schedule.userId, slot),
          });
        }

        // Open-ended prescriptions: ask once, the day before the schedule ends.
        if (
          schedule.medication.durationDays === null &&
          endDate !== null &&
          schedule.renewalNotifiedAt === null &&
          addDaysIso(today, 1) >= endDate
        ) {
          const entry = renewals.get(schedule.userId) ?? {
            scheduleIds: [],
            language: schedule.user.language,
          };
          entry.scheduleIds.push(schedule.id);
          renewals.set(schedule.userId, entry);
        }
      }

      if (rows.length > 0) {
        const created = await this.prisma.reminder.createMany({ data: rows, skipDuplicates: true });
        stats.rowsCreated += created.count;
        // A slot cancelled earlier (STOP REMINDERS, pause) that the schedule still has comes back when
        // the user resumes. Only slots the schedule CURRENTLY produces: after "Time badlo" the old
        // times are not in this set, so their cancelled rows stay cancelled.
        for (const [scheduleId, slots] of bySchedule) {
          await this.prisma.reminder.updateMany({
            where: { scheduleId, status: 'cancelled', scheduledAt: { in: slots } },
            data: { status: 'pending', sentAt: null, ackAt: null, snoozeCount: 0 },
          });
        }
        stats.jobsEnsured += await this.ensureJobs(rows, now);
      }
    }

    // 3. Renewal questions (one per user).
    for (const [userId, entry] of renewals) {
      stats.renewalsAsked += await this.askRenewal(userId, entry, now);
    }

    // 4. Optional evening summary, once per day (behind DAILY_SUMMARY_ENABLED).
    if (!scope.userId && this.env.DAILY_SUMMARY_ENABLED) {
      stats.summariesSent = await this.sendDailySummaries(now);
    }

    this.logger.info({ ...stats }, 'reminder planner run');
    return stats;
  }

  /** One slot job per distinct (user, time) that still has a pending row. */
  private async ensureJobs(
    rows: readonly Prisma.ReminderCreateManyInput[],
    now: Date,
  ): Promise<number> {
    const slots = new Map<string, { userId: string; at: Date }>();
    for (const row of rows) {
      const at = row.scheduledAt as Date;
      slots.set(`${row.userId}|${at.getTime()}`, { userId: row.userId, at });
    }
    let ensured = 0;
    for (const { userId, at } of slots.values()) {
      const pending = await this.prisma.reminder.count({
        where: { userId, scheduledAt: at, status: 'pending' },
      });
      if (pending > 0) {
        await this.queue.addSlot(userId, at, now);
        ensured += 1;
      }
    }
    return ensured;
  }

  private async askRenewal(
    userId: string,
    entry: { scheduleIds: string[]; language: 'hi' | 'en' },
    now: Date,
  ): Promise<number> {
    // Claim first (conditional), so two planner runs never ask twice.
    const claimed = await this.prisma.reminderSchedule.updateMany({
      where: { id: { in: entry.scheduleIds }, renewalNotifiedAt: null },
      data: { renewalNotifiedAt: now },
    });
    if (claimed.count === 0) return 0;
    const days = this.env.REMINDER_OPEN_ENDED_DAYS;
    const { language } = entry;
    try {
      await this.outbound.enqueue(userId, {
        content: {
          kind: 'buttons',
          body: this.i18n.t(language, 'reminder.renew_body', { days }),
          buttons: [
            { id: BUTTON_ID.renewYes, title: this.i18n.t(language, 'reminder.btn.renew') },
            { id: BUTTON_ID.renewNo, title: this.i18n.t(language, 'reminder.btn.not_now') },
          ],
        },
        templateFallback: {
          kind: 'template',
          template: 'reminder_renewal',
          language,
          buttonPayloads: [BUTTON_ID.renewYes, BUTTON_ID.renewNo],
        },
        sourceMessageId: `ren_${userId}_${isoDate(now)}`,
        replyIndex: 0,
      });
      return 1;
    } catch (error) {
      // Un-claim so the next run tries again.
      await this.prisma.reminderSchedule.updateMany({
        where: { id: { in: entry.scheduleIds } },
        data: { renewalNotifiedAt: null },
      });
      this.logger.warn({ user_id: userId, error: (error as Error).name }, 'renewal ask failed');
      return 0;
    }
  }

  /**
   * "Today you took 4 of 5 doses." Sent by the planner run that falls between 21:30 and 21:45 local
   * time. No state is needed to stay at one per day: the outbound job id is `sum_<user>_<date>`.
   * (All users are on Asia/Kolkata today; a per-user zone would group by `users.timezone`.)
   */
  private async sendDailySummaries(now: Date): Promise<number> {
    const timezone = DEFAULT_TIMEZONE;
    const clock = localTimeOf(now, timezone);
    if (clock < '21:30' || clock >= '21:45') return 0;
    const today = localDateOf(now, timezone);
    const counts = await this.prisma.reminder.groupBy({
      by: ['userId', 'status'],
      where: {
        scheduledAt: {
          gte: toInstant(today, '00:00', timezone),
          lt: toInstant(addDaysIso(today, 1), '00:00', timezone),
        },
        status: { in: ['taken', 'skipped', 'missed', 'sent', 'snoozed'] },
        user: { remindersEnabled: true, deletedAt: null, onboardingStep: 'done' },
      },
      _count: { _all: true },
    });
    const perUser = new Map<string, { taken: number; total: number }>();
    for (const row of counts) {
      const entry = perUser.get(row.userId) ?? { taken: 0, total: 0 };
      entry.total += row._count._all;
      if (row.status === 'taken') entry.taken += row._count._all;
      perUser.set(row.userId, entry);
    }
    if (perUser.size === 0) return 0;
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...perUser.keys()] } },
      select: { id: true, language: true },
    });
    let sent = 0;
    for (const user of users) {
      const entry = perUser.get(user.id);
      if (!entry) continue;
      try {
        await this.outbound.enqueue(user.id, {
          content: {
            kind: 'text',
            body: this.i18n.t(user.language, 'reminder.daily_summary', {
              taken: entry.taken,
              total: entry.total,
            }),
          },
          templateFallback: {
            kind: 'template',
            template: 'daily_summary',
            language: user.language,
            params: { taken: String(entry.taken), total: String(entry.total) },
          },
          sourceMessageId: `sum_${user.id}_${today}`,
          replyIndex: 0,
        });
        sent += 1;
      } catch (error) {
        this.logger.warn(
          { user_id: user.id, error: (error as Error).name },
          'daily summary failed',
        );
      }
    }
    return sent;
  }
}
