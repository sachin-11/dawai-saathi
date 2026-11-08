import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import { addDaysIso, dateFromIso, isoDate, localDateOf, localTimeOf, toInstant } from './clock';
import { REMINDER_ACTIVE_STATUSES } from './reminders.constants';
import { ReminderPlannerService } from './reminder-planner.service';
import { ReminderQueue } from './reminder.queue';
import {
  applyCustomTimes,
  type DefaultTimesConfig,
  type ExclusionReason,
  exclusionReason,
  timesFor,
} from './schedule-times';

export type SkipReason = ExclusionReason | 'ended';

export interface PlannedSchedule {
  medicationId: string;
  name: string;
  times: string[];
  startDate: string;
  endDate: string;
  openEnded: boolean;
}
export interface SkippedMedicine {
  /** Null when the medicine was not read clearly: its name is then never shown. */
  name: string | null;
  reason: SkipReason;
}
export interface SchedulePlan {
  documentId: string;
  planned: PlannedSchedule[];
  skipped: SkippedMedicine[];
  /** Highest daily frequency among the planned medicines (how many times "Time badlo" must give). */
  neededTimes: number;
}

export interface ScheduleListItem {
  id: string;
  name: string;
  times: string[];
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  timezone: string;
  today: string;
}

export type CustomTimesResult =
  { ok: true; plan: SchedulePlan } | { ok: false; reason: 'too_few'; needed: number };

/** Schedules: build from saved medications, confirm, pause/resume, cancel. */
@Injectable()
export class ReminderScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planner: ReminderPlannerService,
    private readonly queue: ReminderQueue,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReminderScheduleService.name);
  }

  private get defaults(): DefaultTimesConfig {
    return {
      morning: this.env.MED_TIME_MORNING,
      afternoon: this.env.MED_TIME_AFTERNOON,
      evening: this.env.MED_TIME_EVENING,
      night: this.env.MED_TIME_NIGHT,
    };
  }

  /**
   * What reminders a prescription would get, built ONLY from the saved `medications` rows. Null when
   * the document is not the user's. `custom` replaces the default times (the "Time badlo" answer).
   */
  async plan(
    userId: string,
    documentId: string,
    now: Date = new Date(),
    custom?: readonly string[],
  ): Promise<SchedulePlan | null> {
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) return null;
    const medications = await this.prisma.medication.findMany({
      where: { userId, documentId },
      orderBy: { rawName: 'asc' },
      select: {
        id: true,
        rawName: true,
        active: true,
        asNeeded: true,
        frequencyPerDay: true,
        timings: true,
        startDate: true,
        endDate: true,
        durationDays: true,
      },
    });
    if (medications.length === 0) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const timezone = user?.timezone ?? 'Asia/Kolkata';
    const today = localDateOf(now, timezone);

    const planned: PlannedSchedule[] = [];
    const skipped: SkippedMedicine[] = [];
    let slotIndex = 0;

    for (const medication of medications) {
      const reason = exclusionReason(medication);
      if (reason) {
        skipped.push({ name: medication.active ? medication.rawName : null, reason });
        continue;
      }
      const startDate = [isoDate(medication.startDate), today].sort().at(-1) as string;
      const openEnded = medication.durationDays === null || medication.endDate === null;
      const endDate = medication.endDate
        ? isoDate(medication.endDate)
        : addDaysIso(startDate, this.env.REMINDER_OPEN_ENDED_DAYS - 1);
      if (endDate < today) {
        skipped.push({ name: medication.rawName, reason: 'ended' });
        continue;
      }

      let times: string[] | null;
      if (this.env.REMINDER_TEST_OFFSET_MIN !== undefined) {
        // DEV ONLY (refused in production): the slots start N minutes from now, 2 minutes apart.
        const frequency = medication.frequencyPerDay ?? 1;
        times = Array.from({ length: frequency }, () => {
          const at = new Date(
            now.getTime() +
              ((this.env.REMINDER_TEST_OFFSET_MIN as number) + 2 * slotIndex) * 60_000,
          );
          slotIndex += 1;
          return localTimeOf(at, timezone);
        });
      } else if (custom) {
        times = applyCustomTimes(medication.frequencyPerDay as number, custom);
      } else {
        times = timesFor(medication, this.defaults);
      }
      if (!times) {
        skipped.push({ name: medication.rawName, reason: 'no_frequency' });
        continue;
      }
      planned.push({
        medicationId: medication.id,
        name: medication.rawName,
        times,
        startDate,
        endDate,
        openEnded,
      });
    }

    const neededTimes = Math.max(
      0,
      ...medications
        .filter((medication) => exclusionReason(medication) === null)
        .map((medication) => medication.frequencyPerDay ?? 0),
    );
    return { documentId, planned, skipped, neededTimes };
  }

  /** `plan` with the user's own times; `too_few` when they gave fewer than a medicine needs. */
  async planWithCustomTimes(
    userId: string,
    documentId: string,
    custom: readonly string[],
    now: Date = new Date(),
  ): Promise<CustomTimesResult | null> {
    const base = await this.plan(userId, documentId, now);
    if (!base) return null;
    if (custom.length < base.neededTimes) {
      return { ok: false, reason: 'too_few', needed: base.neededTimes };
    }
    const plan = await this.plan(userId, documentId, now, custom);
    return plan ? { ok: true, plan } : null;
  }

  /** Save the schedules and materialise the first slots right away. Returns the first slot, if any. */
  async create(
    userId: string,
    plan: SchedulePlan,
    now: Date = new Date(),
  ): Promise<{ schedules: number; firstSlot: Date | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const timezone = user?.timezone ?? 'Asia/Kolkata';

    for (const item of plan.planned) {
      const existing = await this.prisma.reminderSchedule.findUnique({
        where: { medicationId: item.medicationId },
        select: { id: true, userId: true },
      });
      // Defence in depth: the medication must be the caller's.
      if (existing && existing.userId !== userId) continue;
      await this.prisma.reminderSchedule.upsert({
        where: { medicationId: item.medicationId },
        create: {
          userId,
          medicationId: item.medicationId,
          times: item.times,
          startDate: dateFromIso(item.startDate),
          endDate: dateFromIso(item.endDate),
          timezone,
        },
        update: {
          times: item.times,
          startDate: dateFromIso(item.startDate),
          endDate: dateFromIso(item.endDate),
          timezone,
          status: 'active',
          renewalNotifiedAt: null,
        },
      });
      // New times replace the old ones: drop what was planned for the old times.
      if (existing) await this.cancelRows({ userId, medicationIds: [item.medicationId] });
    }

    await this.audit.log({
      actor: 'user',
      userId,
      action: 'reminders_scheduled',
      metadata: { schedules: plan.planned.length },
    });
    await this.planner.planUser(userId, now);

    const first = await this.prisma.reminder.findFirst({
      where: { userId, status: 'pending', scheduledAt: { gte: now } },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });
    return { schedules: plan.planned.length, firstSlot: first?.scheduledAt ?? null };
  }

  /**
   * Cancel what is still open for a user (all of it, or only some medicines / one schedule) and
   * remove the queued jobs of slots nothing else is waiting on. Returns the cancelled row count.
   */
  async cancelRows(scope: {
    userId: string;
    medicationIds?: readonly string[];
    scheduleId?: string;
  }): Promise<number> {
    const where = {
      userId: scope.userId,
      status: { in: [...REMINDER_ACTIVE_STATUSES] },
      ...(scope.medicationIds ? { medicationId: { in: [...scope.medicationIds] } } : {}),
      ...(scope.scheduleId ? { scheduleId: scope.scheduleId } : {}),
    };
    const affected = await this.prisma.reminder.findMany({
      where,
      select: { scheduledAt: true },
      distinct: ['scheduledAt'],
    });
    const result = await this.prisma.reminder.updateMany({ where, data: { status: 'cancelled' } });

    const orphaned: Date[] = [];
    for (const { scheduledAt } of affected) {
      const remaining = await this.prisma.reminder.count({
        where: {
          userId: scope.userId,
          scheduledAt,
          status: { in: [...REMINDER_ACTIVE_STATUSES] },
        },
      });
      if (remaining === 0) orphaned.push(scheduledAt);
    }
    if (orphaned.length > 0) await this.queue.removeSlotJobs(scope.userId, orphaned);
    return result.count;
  }

  /** STOP REMINDERS: nothing more is sent. Schedules stay, so START REMINDERS can bring them back. */
  async suspendAll(userId: string): Promise<number> {
    return this.cancelRows({ userId });
  }

  /** START REMINDERS: plan the next hours again. */
  async resumeAll(userId: string, now: Date = new Date()): Promise<void> {
    await this.planner.planUser(userId, now);
  }

  /** `[Galti hai]` (or a deactivated medicine): the document's schedules are cancelled for good. */
  async cancelForDocument(userId: string, documentId: string): Promise<number> {
    const medications = await this.prisma.medication.findMany({
      where: { userId, documentId },
      select: { id: true },
    });
    const ids = medications.map((medication) => medication.id);
    if (ids.length === 0) return 0;
    await this.prisma.reminderSchedule.updateMany({
      where: { userId, medicationId: { in: ids }, status: { in: ['active', 'paused'] } },
      data: { status: 'cancelled' },
    });
    return this.cancelRows({ userId, medicationIds: ids });
  }

  async pauseOne(userId: string, scheduleId: string): Promise<boolean> {
    const result = await this.prisma.reminderSchedule.updateMany({
      where: { id: scheduleId, userId, status: 'active' },
      data: { status: 'paused' },
    });
    if (result.count === 0) return false;
    await this.cancelRows({ userId, scheduleId });
    return true;
  }

  async resumeOne(userId: string, scheduleId: string, now: Date = new Date()): Promise<boolean> {
    const result = await this.prisma.reminderSchedule.updateMany({
      where: { id: scheduleId, userId, status: 'paused' },
      data: { status: 'active' },
    });
    if (result.count === 0) return false;
    await this.planner.planUser(userId, now);
    return true;
  }

  /** Active and paused schedules with their medicine names and today's dose status. */
  async list(userId: string, now: Date = new Date()): Promise<ScheduleListItem[]> {
    const schedules = await this.prisma.reminderSchedule.findMany({
      where: { userId, status: { in: ['active', 'paused'] } },
      orderBy: { medication: { rawName: 'asc' } },
      select: {
        id: true,
        times: true,
        status: true,
        timezone: true,
        medication: { select: { rawName: true } },
      },
    });
    return schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.medication.rawName,
      times: schedule.times,
      status: schedule.status,
      timezone: schedule.timezone,
      today: localDateOf(now, schedule.timezone),
    }));
  }

  /** "Yes, continue" on the renewal question: extend every open-ended schedule that ends soon. */
  async renew(userId: string, now: Date = new Date()): Promise<string | null> {
    const schedules = await this.prisma.reminderSchedule.findMany({
      where: {
        userId,
        status: { in: ['active', 'completed'] },
        medication: { durationDays: null },
      },
      select: { id: true, endDate: true, timezone: true },
    });
    let latest = null as string | null;
    for (const schedule of schedules) {
      const today = localDateOf(now, schedule.timezone);
      const current = schedule.endDate ? isoDate(schedule.endDate) : today;
      // Only schedules ending within a day (or just ended): never extend an old finished course.
      if (current < addDaysIso(today, -1) || current > addDaysIso(today, 1)) continue;
      const base = current < today ? today : current;
      const endDate = addDaysIso(base, this.env.REMINDER_OPEN_ENDED_DAYS);
      await this.prisma.reminderSchedule.update({
        where: { id: schedule.id },
        data: { endDate: dateFromIso(endDate), status: 'active', renewalNotifiedAt: null },
      });
      latest = latest === null || endDate > latest ? endDate : latest;
    }
    if (latest) await this.planner.planUser(userId, now);
    return latest;
  }

  /** Today's dose status per medicine, for MEDS: `{medicationId -> [{time, status}]}`. */
  async todayStatus(
    userId: string,
    now: Date = new Date(),
  ): Promise<Map<string, { time: string; status: string }[]>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const timezone = user?.timezone ?? 'Asia/Kolkata';
    const today = localDateOf(now, timezone);
    const dayStart = toInstant(today, '00:00', timezone);
    const dayEnd = toInstant(addDaysIso(today, 1), '00:00', timezone);
    const rows = await this.prisma.reminder.findMany({
      where: { userId, scheduledAt: { gte: dayStart, lt: dayEnd } },
      select: { medicationId: true, scheduledAt: true, status: true },
      orderBy: { scheduledAt: 'asc' },
    });
    const byMedication = new Map<string, { time: string; status: string }[]>();
    for (const row of rows) {
      const list = byMedication.get(row.medicationId) ?? [];
      list.push({ time: localTimeOf(row.scheduledAt, timezone), status: row.status });
      byMedication.set(row.medicationId, list);
    }
    return byMedication;
  }
}
