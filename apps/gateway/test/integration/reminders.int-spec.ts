/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code: a missing value fails the test anyway */
/**
 * M10 integration tests (real Postgres from docker-compose.test.yml, in-memory queue + outbound, a
 * fake clock in Asia/Kolkata). They drive the REAL services: schedule creation, planner, slot sender,
 * missed-checker, acknowledgements, caregiver alerts.
 */
import { randomUUID } from 'node:crypto';

import { isWithinWindow } from '../../src/messaging/window';
import { TemplateRegistry } from '../../src/messaging/template.registry';
import { toInstant, localTimeOf } from '../../src/reminders/clock';
import {
  createHarness,
  createUserWithPrescription,
  createVerifiedCaregiver,
  epochSeconds,
  fakeSession,
  type Harness,
} from '../support/reminder-harness';

jest.setTimeout(180_000);

const IST = 'Asia/Kolkata';
const ist = (date: string, time: string): Date => toInstant(date, time, IST);
const addMin = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * 60_000);
const registry = new TemplateRegistry();

describe('reminders (integration)', () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function touchInbound(userId: string, at: Date): Promise<void> {
    await h.prisma.user.update({ where: { id: userId }, data: { lastInboundAt: at } });
  }

  describe('full lifecycle: 5-day prescription, 2 doses a day, 2 medicines', () => {
    it('sends one grouped message per slot and ends with the right statuses, alerts and completion', async () => {
      const day1 = '2026-11-10';
      const t0 = ist(day1, '06:30');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: day1,
        durationDays: 5,
        lastInboundAt: t0,
      });
      await createVerifiedCaregiver(h, rx.userId, 'Papa');

      // ---- confirmation summary: built only from the saved medications
      const plan = await h.schedules.plan(rx.userId, rx.documentId, t0);
      expect(plan?.planned.map((item) => [item.name, item.times])).toEqual([
        ['Dolo 650', ['08:00', '21:00']],
        ['Metformin 500', ['08:00', '21:00']],
      ]);
      expect(plan?.planned.every((item) => item.endDate === '2026-11-14' && !item.openEnded)).toBe(
        true,
      );
      expect(plan?.skipped).toEqual(
        expect.arrayContaining([
          { name: 'Crocin SOS', reason: 'as_needed' },
          { name: null, reason: 'not_active' },
        ]),
      );
      // a stranger's document id gives nothing
      expect(await h.schedules.plan(randomUUID(), rx.documentId, t0)).toBeNull();

      const created = await h.schedules.create(rx.userId, plan!, t0);
      expect(created.schedules).toBe(2);
      // Times are stored as UTC instants: 08:00 IST = 02:30 UTC.
      expect(created.firstSlot?.toISOString()).toBe('2026-11-10T02:30:00.000Z');

      const slots: Date[] = [];
      for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']) {
        slots.push(ist(day, '08:00'), ist(day, '21:00'));
      }

      // ---- the scripted user (minutes after the slot): index -> actions
      type Act = { at: number; do: 'taken' | 'snooze' | 'skip' | 'text_taken' };
      const script: Record<number, Act[]> = {
        0: [{ at: 5, do: 'taken' }],
        1: [
          { at: 5, do: 'snooze' },
          { at: 40, do: 'taken' },
        ],
        // 2, 3: no answer -> two missed in a row -> caregiver alert
        4: [{ at: 10, do: 'taken' }], // resets the streak
        5: [{ at: 10, do: 'skip' }], // skipped is not missed
        6: [{ at: 120, do: 'text_taken' }], // missed at +60, "le li" at +120 = late dose
        // 7, 8, 9: missed (alert at 8 and 9)
      };
      const replies: string[] = [];
      const loudSession = {
        text: (key: string) => {
          replies.push(key);
          return Promise.resolve();
        },
      } as unknown as Parameters<Harness['acks']['handleButton']>[3];

      const end = ist('2026-11-15', '06:00');
      for (let t = t0; t <= end; t = addMin(t, 5)) {
        if (t.getUTCMinutes() % 15 === 0) {
          await h.worker.process({ id: 'planner', name: 'planner', data: {} }, t);
        }
        await h.runDue(t);
        for (const [index, acts] of Object.entries(script)) {
          const slot = slots[Number(index)]!;
          for (const act of acts) {
            if (addMin(slot, act.at).getTime() !== t.getTime()) continue;
            await touchInbound(rx.userId, t);
            const epoch = epochSeconds(slot);
            if (act.do === 'text_taken')
              await h.acks.handleText(rx.userId, 'taken', loudSession, t);
            else await h.acks.handleButton(rx.userId, act.do, epoch, loudSession, t);
          }
        }
      }

      // ---- one grouped message per slot (+ one snooze re-send)
      const reminders = h.outbound.reminders(rx.userId);
      expect(reminders).toHaveLength(11);
      const first = reminders[0]!.request;
      expect(first.content.kind).toBe('buttons');
      const body = (first.content as { body: string }).body;
      expect(body).toContain('Dolo 650');
      expect(body).toContain('Metformin 500');
      expect(body).not.toContain('Crocin');
      expect(body).toContain('08:00');
      expect(body).toContain('खाने के बाद'); // food relation comes from the DB, in the user's language
      const buttons = (first.content as { buttons: { id: string; title: string }[] }).buttons;
      expect(buttons).toHaveLength(3);
      expect(buttons.every((button) => button.title.length <= 20 && button.id.length <= 128)).toBe(
        true,
      );
      expect(buttons[0]!.id).toBe(`rem:taken:${epochSeconds(slots[0]!)}`);

      // every reminder has a valid template fallback (used outside the 24 h window)
      for (const item of reminders) {
        const fallback = item.request.templateFallback!;
        expect(fallback.kind).toBe('template');
        expect(() =>
          registry.build(
            fallback.template,
            fallback.language,
            fallback.params,
            fallback.buttonPayloads,
          ),
        ).not.toThrow();
      }
      // window logic: inside 24 h an interactive message goes out, otherwise the template does
      expect(isWithinWindow(t0, reminders[0]!.at)).toBe(true);
      const slot4 = reminders.find((item) =>
        item.request.sourceMessageId.endsWith(`_${epochSeconds(slots[4]!)}`),
      )!;
      expect(isWithinWindow(ist('2026-11-10', '21:40'), slot4.at)).toBe(false);

      // ---- final statuses per slot
      const rows = await h.prisma.reminder.findMany({
        where: { userId: rx.userId },
        orderBy: { scheduledAt: 'asc' },
      });
      expect(rows).toHaveLength(20);
      const statusOf = (index: number): string[] =>
        rows
          .filter((row) => row.scheduledAt.getTime() === slots[index]!.getTime())
          .map((row) => row.status);
      expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => statusOf(i)[0])).toEqual([
        'taken',
        'taken',
        'missed',
        'missed',
        'taken',
        'skipped',
        'taken', // late
        'missed',
        'missed',
        'missed',
      ]);
      // both medicines of a slot always share the status
      for (let i = 0; i < 10; i += 1) {
        expect(new Set(statusOf(i)).size).toBe(1);
      }
      expect(
        rows
          .filter((row) => row.scheduledAt.getTime() === slots[1]!.getTime())
          .every((row) => row.snoozeCount === 1),
      ).toBe(true);
      expect(rows.every((row) => row.sentAt !== null)).toBe(true);
      expect(rows.every((row) => row.jobId.startsWith(`rem_${rx.userId}_`))).toBe(true);

      // ---- consecutive misses: 7, 8, 9 after the late dose reset the streak
      const user = await h.prisma.user.findUniqueOrThrow({ where: { id: rx.userId } });
      expect(user.consecutiveMisses).toBe(3);

      // ---- caregiver alerts: slot 3 (2nd miss in a row), 8 and 9; label + time ONLY
      const alerts = h.outbound.toCaregivers(rx.userId);
      expect(alerts).toHaveLength(3);
      for (const alert of alerts) {
        expect(alert.request.content.kind).toBe('template');
        const content = alert.request.content as {
          template: string;
          params: Record<string, string>;
        };
        expect(content.template).toBe('caregiver_missed_dose_alert');
        expect(Object.keys(content.params).sort()).toEqual(['time', 'user_label']);
        expect(content.params['user_label']).toBe('Papa');
        const serialised = JSON.stringify(alert.request);
        for (const secret of ['Dolo', 'Metformin', 'Crocin', 'tablet']) {
          expect(serialised).not.toContain(secret);
        }
      }
      expect(
        alerts.map(
          (alert) => (alert.request.content as { params: Record<string, string> }).params['time'],
        ),
      ).toEqual(['21:00', '08:00', '21:00']);
      expect(localTimeOf(slots[3]!, IST)).toBe('21:00');

      // ---- completion: both schedules end, nothing is sent after the last slot
      const schedules = await h.prisma.reminderSchedule.findMany({ where: { userId: rx.userId } });
      expect(schedules.map((schedule) => schedule.status)).toEqual(['completed', 'completed']);
      expect(reminders.every((item) => item.at.getTime() <= addMin(slots[9]!, 60).getTime())).toBe(
        true,
      );
      expect(h.queue.forUser(rx.userId)).toEqual([]);
      expect(replies).toEqual(
        expect.arrayContaining(['reminder.ack_taken', 'reminder.ack_snooze', 'reminder.ack_skip']),
      );
    });
  });

  describe('planner', () => {
    it('is idempotent: repeated runs create no duplicate rows or jobs', async () => {
      const t0 = ist('2026-12-01', '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-01',
        durationDays: 10,
        lastInboundAt: t0,
      });
      const plan = await h.schedules.plan(rx.userId, rx.documentId, t0);
      await h.schedules.create(rx.userId, plan!, t0);

      const count = (): Promise<number> =>
        h.prisma.reminder.count({ where: { userId: rx.userId } });
      const afterFirst = await count();
      const jobsFirst = h.queue.forUser(rx.userId).length;
      for (let i = 0; i < 3; i += 1) await h.planner.planUser(rx.userId, t0);
      expect(await count()).toBe(afterFirst);
      expect(h.queue.forUser(rx.userId).length).toBe(jobsFirst);
      // rolling window: 36 h from 06:00 = slots at 08:00, 21:00 (day 1) and 08:00 (day 2), x2 medicines
      expect(afterFirst).toBe(6);

      // a day later the window has moved: the missed day-1 rows were closed silently, two new slots
      // (day 2 21:00, day 3 08:00) appear for both medicines, and nothing is duplicated
      await h.planner.planUser(rx.userId, ist('2026-12-02', '06:30'));
      expect(await count()).toBe(10);
      expect(
        await h.prisma.reminder.count({ where: { userId: rx.userId, status: 'missed' } }),
      ).toBe(4);
      expect(
        (await h.prisma.user.findUniqueOrThrow({ where: { id: rx.userId } })).consecutiveMisses,
      ).toBe(0);
    });

    it('never sends a late reminder: a slot job older than 10 minutes marks the rows missed silently', async () => {
      const t0 = ist('2026-12-03', '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-03',
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );

      const slot = ist('2026-12-03', '08:00');
      expect(await h.dispatch.sendSlot(rx.userId, slot, addMin(slot, 11))).toBe('too_late');
      const rows = await h.prisma.reminder.findMany({
        where: { userId: rx.userId, scheduledAt: slot },
      });
      expect(rows.map((row) => row.status)).toEqual(['missed', 'missed']);
      expect(h.outbound.reminders(rx.userId)).toHaveLength(0);
      // silent: not counted towards the caregiver alert, no missed-check job queued
      expect(
        (await h.prisma.user.findUniqueOrThrow({ where: { id: rx.userId } })).consecutiveMisses,
      ).toBe(0);
      expect(h.queue.forUser(rx.userId).filter((job) => job.name === 'alert')).toEqual([]);
    });

    it('marks overdue pending rows missed silently when the server was down', async () => {
      const t0 = ist('2026-12-05', '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-05',
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );
      // nobody ran the 08:00 job; the planner wakes up at 08:40
      const stats = await h.planner.planUser(rx.userId, ist('2026-12-05', '08:40'));
      expect(stats.missedSilently).toBe(2);
      expect(h.outbound.reminders(rx.userId)).toHaveLength(0);
      expect(
        (await h.prisma.user.findUniqueOrThrow({ where: { id: rx.userId } })).consecutiveMisses,
      ).toBe(0);
    });

    it('skips paused schedules and users with reminders switched off', async () => {
      const t0 = ist('2026-12-07', '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-07',
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );
      const [first] = await h.prisma.reminderSchedule.findMany({ where: { userId: rx.userId } });

      expect(await h.schedules.pauseOne(rx.userId, first!.id)).toBe(true);
      const rowsAfterPause = await h.prisma.reminder.findMany({
        where: { userId: rx.userId, scheduleId: first!.id },
      });
      expect(rowsAfterPause.every((row) => row.status === 'cancelled')).toBe(true);
      await h.planner.planUser(rx.userId, ist('2026-12-08', '06:00'));
      expect(
        await h.prisma.reminder.count({
          where: { userId: rx.userId, scheduleId: first!.id, status: 'pending' },
        }),
      ).toBe(0);
      expect(await h.schedules.resumeOne(rx.userId, first!.id, ist('2026-12-08', '06:00'))).toBe(
        true,
      );
      expect(
        await h.prisma.reminder.count({
          where: { userId: rx.userId, scheduleId: first!.id, status: 'pending' },
        }),
      ).toBeGreaterThan(0);

      await h.prisma.user.update({ where: { id: rx.userId }, data: { remindersEnabled: false } });
      const before = await h.prisma.reminder.count({ where: { userId: rx.userId } });
      await h.planner.planUser(rx.userId, ist('2026-12-09', '06:00'));
      expect(await h.prisma.reminder.count({ where: { userId: rx.userId } })).toBe(before);
    });
  });

  describe('stopping reminders', () => {
    it('STOP REMINDERS cancels pending rows and leaves no queued jobs; START plans again', async () => {
      const t0 = ist('2026-12-10', '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-10',
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );
      expect(h.queue.forUser(rx.userId).length).toBeGreaterThan(0);

      await h.prisma.user.update({ where: { id: rx.userId }, data: { remindersEnabled: false } });
      await h.schedules.suspendAll(rx.userId);
      expect(h.queue.forUser(rx.userId)).toEqual([]);
      expect(
        await h.prisma.reminder.count({ where: { userId: rx.userId, status: 'pending' } }),
      ).toBe(0);
      expect(h.outbound.reminders(rx.userId)).toHaveLength(0);

      await h.prisma.user.update({ where: { id: rx.userId }, data: { remindersEnabled: true } });
      await h.schedules.resumeAll(rx.userId, t0);
      expect(
        await h.prisma.reminder.count({ where: { userId: rx.userId, status: 'pending' } }),
      ).toBeGreaterThan(0);
      expect(h.queue.forUser(rx.userId).length).toBeGreaterThan(0);
    });

    it('a slot job that escapes cancellation still sends nothing (the DB is the truth)', async () => {
      const t0 = ist('2026-12-12', '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-12',
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );
      await h.prisma.reminder.updateMany({
        where: { userId: rx.userId },
        data: { status: 'cancelled' },
      });
      const slot = ist('2026-12-12', '08:00');
      expect(await h.dispatch.sendSlot(rx.userId, slot, slot)).toBe('nothing_pending');
      await h.prisma.user.update({ where: { id: rx.userId }, data: { remindersEnabled: false } });
      await h.prisma.reminder.updateMany({
        where: { userId: rx.userId },
        data: { status: 'pending' },
      });
      expect(await h.dispatch.sendSlot(rx.userId, slot, slot)).toBe('disabled');
      expect(h.outbound.reminders(rx.userId)).toHaveLength(0);
    });

    it('[Galti hai] cancels the document schedules for good', async () => {
      const t0 = ist('2026-12-14', '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-14',
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );
      await h.schedules.cancelForDocument(rx.userId, rx.documentId);
      expect(h.queue.forUser(rx.userId)).toEqual([]);
      const schedules = await h.prisma.reminderSchedule.findMany({ where: { userId: rx.userId } });
      expect(schedules.every((schedule) => schedule.status === 'cancelled')).toBe(true);
      await h.planner.planUser(rx.userId, ist('2026-12-15', '06:00'));
      expect(
        await h.prisma.reminder.count({ where: { userId: rx.userId, status: 'pending' } }),
      ).toBe(0);
    });

    it('deleting the user removes schedules and reminders (cascade)', async () => {
      const t0 = ist('2026-12-16', '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-16',
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );
      await createVerifiedCaregiver(h, rx.userId);
      await h.prisma.user.delete({ where: { id: rx.userId } });
      expect(await h.prisma.reminderSchedule.count({ where: { userId: rx.userId } })).toBe(0);
      expect(await h.prisma.reminder.count({ where: { userId: rx.userId } })).toBe(0);
      expect(await h.prisma.caregiver.count({ where: { userId: rx.userId } })).toBe(0);
      // a leftover job for the deleted user does nothing
      expect(
        await h.dispatch.sendSlot(
          rx.userId,
          ist('2026-12-16', '08:00'),
          ist('2026-12-16', '08:00'),
        ),
      ).toBe('user_gone');
    });
  });

  describe('acknowledgements', () => {
    async function sentSlot(date: string, time = '08:00', custom?: string[]) {
      const t0 = ist(date, '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: date,
        durationDays: 3,
        lastInboundAt: t0,
      });
      const plan = custom
        ? (
            (await h.schedules.planWithCustomTimes(rx.userId, rx.documentId, custom, t0)) as {
              plan: Parameters<Harness['schedules']['create']>[1];
            }
          ).plan
        : (await h.schedules.plan(rx.userId, rx.documentId, t0))!;
      await h.schedules.create(rx.userId, plan, t0);
      const slot = ist(date, time);
      await h.dispatch.sendSlot(rx.userId, slot, slot);
      return { rx, slot, epoch: epochSeconds(slot) };
    }

    it('double taps do not double count', async () => {
      const { rx, slot, epoch } = await sentSlot('2026-12-20');
      const { session, texts } = fakeSession();
      expect(await h.acks.handleButton(rx.userId, 'taken', epoch, session, addMin(slot, 5))).toBe(
        'taken',
      );
      expect(await h.acks.handleButton(rx.userId, 'taken', epoch, session, addMin(slot, 6))).toBe(
        'already',
      );
      expect(await h.acks.handleButton(rx.userId, 'skip', epoch, session, addMin(slot, 7))).toBe(
        'already',
      );
      expect(texts).toEqual(['reminder.ack_taken', 'reminder.already', 'reminder.already']);
      expect(await h.prisma.reminder.count({ where: { userId: rx.userId, status: 'taken' } })).toBe(
        2,
      );
    });

    it('allows two snoozes, then says so; a second tap while snoozed uses no extra snooze', async () => {
      const { rx, slot, epoch } = await sentSlot('2026-12-21');
      const { session } = fakeSession();
      expect(await h.acks.handleButton(rx.userId, 'snooze', epoch, session, addMin(slot, 5))).toBe(
        'snoozed',
      );
      expect(await h.acks.handleButton(rx.userId, 'snooze', epoch, session, addMin(slot, 6))).toBe(
        'already',
      );
      // the 30-minute job re-sends the message
      expect(await h.dispatch.sendSlot(rx.userId, slot, addMin(slot, 35), 1)).toBe('sent');
      expect(await h.acks.handleButton(rx.userId, 'snooze', epoch, session, addMin(slot, 36))).toBe(
        'snoozed',
      );
      expect(await h.dispatch.sendSlot(rx.userId, slot, addMin(slot, 66), 2)).toBe('sent');
      expect(await h.acks.handleButton(rx.userId, 'snooze', epoch, session, addMin(slot, 67))).toBe(
        'snooze_limit',
      );
      // it is still a normal pending reminder: it can be taken
      expect(await h.acks.handleButton(rx.userId, 'taken', epoch, session, addMin(slot, 70))).toBe(
        'taken',
      );
      expect(h.outbound.reminders(rx.userId)).toHaveLength(3); // original + 2 re-sends
    });

    it('a snooze never pushes a reminder into quiet hours (22:30-06:30)', async () => {
      const { rx, slot, epoch } = await sentSlot('2026-12-22', '22:10', ['21:00', '22:10']);
      const { session, texts } = fakeSession();
      // 22:10 + 30 min = 22:40 is quiet
      expect(await h.acks.handleButton(rx.userId, 'snooze', epoch, session, slot)).toBe(
        'snooze_quiet',
      );
      expect(texts).toEqual(['reminder.snooze_quiet']);
      // nothing changed: the reminder is still waiting and no snooze job exists
      expect(await h.prisma.reminder.count({ where: { userId: rx.userId, status: 'sent' } })).toBe(
        2,
      );
      expect(h.queue.forUser(rx.userId).filter((job) => job.name === 'snooze')).toEqual([]);
    });

    it('skipped is not missed: no counter, no caregiver alert', async () => {
      const { rx, slot, epoch } = await sentSlot('2026-12-23');
      const { session } = fakeSession();
      expect(await h.acks.handleButton(rx.userId, 'skip', epoch, session, addMin(slot, 5))).toBe(
        'skipped',
      );
      const result = await h.dispatch.checkMissed(rx.userId, slot, addMin(slot, 61));
      expect(result.missed).toBe(0);
      expect(
        (await h.prisma.user.findUniqueOrThrow({ where: { id: rx.userId } })).consecutiveMisses,
      ).toBe(0);
    });

    it('a late "le li" within 6 hours counts; after that it does not', async () => {
      const { rx, slot, epoch } = await sentSlot('2026-12-24');
      const { session } = fakeSession();
      await h.dispatch.checkMissed(rx.userId, slot, addMin(slot, 61));
      expect(
        (await h.prisma.user.findUniqueOrThrow({ where: { id: rx.userId } })).consecutiveMisses,
      ).toBe(1);
      expect(
        await h.acks.handleButton(rx.userId, 'taken', epoch, session, addMin(slot, 5 * 60)),
      ).toBe('taken_late');
      expect(
        (await h.prisma.user.findUniqueOrThrow({ where: { id: rx.userId } })).consecutiveMisses,
      ).toBe(0);

      const other = await sentSlot('2026-12-25');
      await h.dispatch.checkMissed(other.rx.userId, other.slot, addMin(other.slot, 61));
      expect(
        await h.acks.handleButton(
          other.rx.userId,
          'taken',
          other.epoch,
          session,
          addMin(other.slot, 7 * 60),
        ),
      ).toBe('expired');
    });

    it('text answers only count within 2 hours of the latest reminder', async () => {
      const { rx, slot } = await sentSlot('2026-12-26');
      const { session } = fakeSession();
      expect(await h.acks.handleText(rx.userId, 'taken', session, addMin(slot, 150))).toBeNull();
      expect(await h.acks.handleText(rx.userId, 'taken', session, addMin(slot, 90))).toBe('taken');
    });

    it("one user's button cannot answer another user's reminder", async () => {
      const a = await sentSlot('2026-12-27');
      const b = await sentSlot('2026-12-27');
      const { session } = fakeSession();
      expect(
        await h.acks.handleButton(b.rx.userId, 'taken', a.epoch, session, addMin(a.slot, 5)),
      ).toBe('taken');
      // a's rows are untouched
      expect(
        await h.prisma.reminder.count({ where: { userId: a.rx.userId, status: 'taken' } }),
      ).toBe(0);
    });
  });

  describe('missed doses and caregiver alerts', () => {
    it('queues the alert on the 2nd miss in a row, not on the 1st, and resets on taken', async () => {
      const day = '2026-12-28';
      const t0 = ist(day, '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: day,
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );
      const s1 = ist(day, '08:00');
      const s2 = ist(day, '21:00');
      await h.dispatch.sendSlot(rx.userId, s1, s1);
      await h.dispatch.sendSlot(rx.userId, s2, s2);

      expect((await h.dispatch.checkMissed(rx.userId, s1, addMin(s1, 61))).alerted).toBe(false);
      const second = await h.dispatch.checkMissed(rx.userId, s2, addMin(s2, 61));
      expect(second).toMatchObject({ consecutiveMisses: 2, alerted: true });
      // repeating the check does nothing (rows are not `sent` any more)
      expect((await h.dispatch.checkMissed(rx.userId, s2, addMin(s2, 62))).missed).toBe(0);
      expect(h.queue.forUser(rx.userId).filter((job) => job.name === 'alert')).toHaveLength(1);
    });

    it('throttles: 1 alert per caregiver per 6 hours and 3 per day', async () => {
      const t0 = ist('2026-12-29', '00:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-29',
        durationDays: 3,
        lastInboundAt: t0,
      });
      const caregiverId = await createVerifiedCaregiver(h, rx.userId);
      // each alert belongs to a different missed slot (the job id is per slot)
      const at = (time: string) => ist('2026-12-29', time);
      const alert = async (now: Date) =>
        (await h.caregivers.alertMissedDose(rx.userId, new Date(now.getTime() - 3_600_000), now))
          .outcome;
      expect(await alert(at('00:10'))).toBe('sent');
      expect(await alert(at('05:00'))).toBe('throttled');
      expect(await alert(at('06:20'))).toBe('sent');
      expect(await alert(at('12:30'))).toBe('sent');
      // 18:40 is more than 6 h later but it would be the 4th today
      expect(await alert(at('18:40'))).toBe('throttled');
      // the next day the counter starts again
      expect(await alert(ist('2026-12-30', '08:00'))).toBe('sent');
      const row = await h.prisma.caregiver.findUniqueOrThrow({ where: { id: caregiverId } });
      expect(row.alertsToday).toBe(1);
      expect(h.outbound.toCaregivers(rx.userId)).toHaveLength(4);
    });

    it('sends no alert to a caregiver who has not said YES or who stopped alerts', async () => {
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2026-12-31',
        durationDays: 3,
        lastInboundAt: new Date(),
      });
      await h.prisma.caregiver.create({
        data: {
          userId: rx.userId,
          waPhoneHash: `p-${randomUUID()}`,
          waPhoneEnc: 'x',
          relation: 'Maa',
          status: 'pending',
        },
      });
      await h.prisma.caregiver.create({
        data: {
          userId: rx.userId,
          waPhoneHash: `r-${randomUUID()}`,
          waPhoneEnc: 'x',
          relation: 'Bhai',
          status: 'removed',
        },
      });
      expect((await h.caregivers.alertMissedDose(rx.userId, new Date(), new Date())).outcome).toBe(
        'no_caregiver',
      );
      expect(h.outbound.toCaregivers(rx.userId)).toHaveLength(0);
    });
  });

  describe('caregiver consent from both sides', () => {
    async function newUser(language: 'hi' | 'en' = 'hi') {
      return createUserWithPrescription(h.prisma, {
        startDate: '2027-01-02',
        durationDays: 3,
        lastInboundAt: new Date(),
        language,
      });
    }

    it('invite -> YES -> verified, both sides notified, audit rows have no PII', async () => {
      const rx = await newUser();
      const number = '9791234567';
      const invited = await h.caregivers.invite(rx.userId, 'hi', number, 'Papa', 'msg-1');
      expect(invited).not.toBeNull();
      const invite = h.outbound.toCaregivers(rx.userId)[0]!;
      expect(invite.request.content).toMatchObject({
        kind: 'template',
        template: 'caregiver_invite',
        params: { user_label: 'Papa' },
      });
      expect(JSON.stringify(invite.request)).not.toContain(number); // never the user's number or the caregiver's

      const job = {
        userId: rx.userId,
        caregiverId: invited!.caregiverId,
        reply: 'yes' as const,
        waMessageId: `wamid.${randomUUID()}`,
      };
      expect(await h.caregivers.handleReply(job)).toBe('verified');
      const row = await h.prisma.caregiver.findUniqueOrThrow({
        where: { id: invited!.caregiverId },
      });
      expect(row.status).toBe('verified');
      expect(row.verifiedAt).not.toBeNull();
      expect(
        h.outbound.sent.filter((item) => item.userId === rx.userId).length,
      ).toBeGreaterThanOrEqual(3);
      // a second YES changes nothing
      expect(await h.caregivers.handleReply({ ...job, waMessageId: `wamid.${randomUUID()}` })).toBe(
        'noop',
      );

      const audit = await h.prisma.auditLog.findMany({
        where: { userId: rx.userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((entry) => entry.action)).toEqual([
        'caregiver_invited',
        'caregiver_verified',
      ]);
      expect(JSON.stringify(audit)).not.toContain(number);
    });

    it('NO declines and tells the user; the caregiver is never alerted', async () => {
      const rx = await newUser();
      const invited = await h.caregivers.invite(rx.userId, 'en', '9812345678', 'Mummy', 'msg-2');
      expect(
        await h.caregivers.handleReply({
          userId: rx.userId,
          caregiverId: invited!.caregiverId,
          reply: 'no',
          waMessageId: 'wamid.n1',
        }),
      ).toBe('declined');
      expect(
        (await h.prisma.caregiver.findUniqueOrThrow({ where: { id: invited!.caregiverId } }))
          .status,
      ).toBe('declined');
      expect((await h.caregivers.alertMissedDose(rx.userId, new Date(), new Date())).outcome).toBe(
        'no_caregiver',
      );
    });

    it('an invite that is not answered within 48 hours expires and the user is told', async () => {
      const rx = await newUser();
      const sent = new Date('2027-01-05T10:00:00Z');
      const invited = await h.caregivers.invite(
        rx.userId,
        'hi',
        '9823456789',
        'Dadaji',
        'msg-3',
        sent,
      );
      await h.caregivers.expireInvites(addMin(sent, 47 * 60));
      expect(
        (await h.prisma.caregiver.findUniqueOrThrow({ where: { id: invited!.caregiverId } }))
          .status,
      ).toBe('pending');
      const before = h.outbound.sent.length;
      expect(await h.caregivers.expireInvites(addMin(sent, 49 * 60))).toBeGreaterThanOrEqual(1);
      expect(
        (await h.prisma.caregiver.findUniqueOrThrow({ where: { id: invited!.caregiverId } }))
          .status,
      ).toBe('declined');
      expect(h.outbound.sent.length).toBeGreaterThan(before);
      // a late YES is refused
      expect(
        await h.caregivers.handleReply(
          {
            userId: rx.userId,
            caregiverId: invited!.caregiverId,
            reply: 'yes',
            waMessageId: 'wamid.late',
          },
          addMin(sent, 50 * 60),
        ),
      ).toBe('noop');
    });

    it('YES after 48 hours (before the sweep ran) is refused as expired', async () => {
      const rx = await newUser();
      const sent = new Date('2027-01-06T10:00:00Z');
      const invited = await h.caregivers.invite(
        rx.userId,
        'hi',
        '9834567890',
        'Papa',
        'msg-4',
        sent,
      );
      expect(
        await h.caregivers.handleReply(
          {
            userId: rx.userId,
            caregiverId: invited!.caregiverId,
            reply: 'yes',
            waMessageId: 'wamid.l2',
          },
          addMin(sent, 50 * 60),
        ),
      ).toBe('expired');
    });

    it('STOP ALERTS removes the caregiver and no more alerts follow', async () => {
      const rx = await newUser();
      const caregiverId = await createVerifiedCaregiver(h, rx.userId);
      expect(
        await h.caregivers.handleReply({
          userId: rx.userId,
          caregiverId,
          reply: 'stop_alerts',
          waMessageId: 'wamid.s1',
        }),
      ).toBe('stopped');
      expect(
        (await h.prisma.caregiver.findUniqueOrThrow({ where: { id: caregiverId } })).status,
      ).toBe('removed');
      expect((await h.caregivers.alertMissedDose(rx.userId, new Date(), new Date())).outcome).toBe(
        'no_caregiver',
      );
    });

    it('allows at most 2 active caregivers, not the user themselves, not the same person twice', async () => {
      const rx = await newUser();
      const own = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
      await h.prisma.user.update({
        where: { id: rx.userId },
        data: { waPhoneHash: h.crypto.hashPhone(own) },
      });
      expect((await h.caregivers.checkNewNumber(rx.userId, `+91 ${own}`)).result).toBe(
        'own_number',
      );
      expect((await h.caregivers.checkNewNumber(rx.userId, '12345')).result).toBe('invalid_number');
      expect((await h.caregivers.checkNewNumber(rx.userId, '+44 7911 123456')).result).toBe(
        'invalid_number',
      );

      expect(await h.caregivers.invite(rx.userId, 'hi', '9856789012', 'Papa', 'm1')).not.toBeNull();
      expect((await h.caregivers.checkNewNumber(rx.userId, '+91 98567 89012')).result).toBe(
        'already',
      );
      expect(await h.caregivers.invite(rx.userId, 'hi', '9867890123', 'Maa', 'm2')).not.toBeNull();
      expect((await h.caregivers.checkNewNumber(rx.userId, '9878901234')).result).toBe('limit');

      expect(await h.caregivers.remove(rx.userId)).toBe(2);
      expect((await h.caregivers.checkNewNumber(rx.userId, '9878901234')).result).toBe('ok');
    });

    it('finds a caregiver by phone for the webhook (pending and verified only)', async () => {
      const rx = await newUser();
      const invited = await h.caregivers.invite(rx.userId, 'hi', '9889012345', 'Papa', 'm9');
      const found = await h.caregivers.findByPhone('919889012345');
      expect(found.map((row) => row.id)).toContain(invited!.caregiverId);
      await h.caregivers.remove(rx.userId);
      expect((await h.caregivers.findByPhone('919889012345')).map((row) => row.id)).not.toContain(
        invited!.caregiverId,
      );
    });
  });

  describe('open-ended prescriptions', () => {
    it('are scheduled for 30 days, then the user is asked ONCE whether to continue', async () => {
      const day = '2027-02-01';
      const t0 = ist(day, '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: day,
        durationDays: null,
        lastInboundAt: t0,
      });
      const plan = await h.schedules.plan(rx.userId, rx.documentId, t0);
      expect(plan?.planned.every((item) => item.openEnded && item.endDate === '2027-03-02')).toBe(
        true,
      );
      await h.schedules.create(rx.userId, plan!, t0);

      // the day before the end the planner asks once
      const eve = ist('2027-03-01', '06:00');
      await h.planner.planUser(rx.userId, eve);
      await h.planner.planUser(rx.userId, addMin(eve, 15));
      expect(
        h.outbound.sent.filter((item) =>
          item.request.sourceMessageId.startsWith(`ren_${rx.userId}`),
        ),
      ).toHaveLength(1);

      const until = await h.schedules.renew(rx.userId, eve);
      expect(until).toBe('2027-04-01');
      const schedules = await h.prisma.reminderSchedule.findMany({ where: { userId: rx.userId } });
      expect(
        schedules.every((schedule) => schedule.endDate?.toISOString().startsWith('2027-04-01')),
      ).toBe(true);
    });
  });

  describe('daily summary (DAILY_SUMMARY_ENABLED)', () => {
    it('is sent once, only in the 21:30-21:45 window, with taken / total (one dose = one medicine at one time)', async () => {
      const on = createHarness({ DAILY_SUMMARY_ENABLED: 'true' });
      try {
        const day = '2027-03-10';
        const t0 = ist(day, '06:00');
        const rx = await createUserWithPrescription(on.prisma, {
          startDate: day,
          durationDays: 3,
          lastInboundAt: t0,
        });
        await on.schedules.create(
          rx.userId,
          (await on.schedules.plan(rx.userId, rx.documentId, t0))!,
          t0,
        );
        const morning = ist(day, '08:00');
        await on.dispatch.sendSlot(rx.userId, morning, morning);
        const { session } = fakeSession();
        await on.acks.handleButton(
          rx.userId,
          'taken',
          epochSeconds(morning),
          session,
          addMin(morning, 5),
        );
        const evening = ist(day, '21:00');
        await on.dispatch.sendSlot(rx.userId, evening, evening);
        await on.dispatch.checkMissed(rx.userId, evening, addMin(evening, 61));

        const summaries = (): number =>
          on.outbound.sent.filter(
            (item) => item.request.sourceMessageId === `sum_${rx.userId}_${day}`,
          ).length;
        await on.planner.planAll(ist(day, '21:15'));
        expect(summaries()).toBe(0);
        const stats = await on.planner.planAll(ist(day, '21:35'));
        expect(stats.summariesSent).toBeGreaterThanOrEqual(1);
        expect(summaries()).toBe(1);
        await on.planner.planAll(ist(day, '21:40'));
        expect(summaries()).toBe(1); // the job id is per user and day
        const request = on.outbound.sent.find(
          (item) => item.request.sourceMessageId === `sum_${rx.userId}_${day}`,
        )!.request;
        expect(request.content).toMatchObject({ kind: 'text' });
        expect((request.content as { body: string }).body).toContain('4 में से 2');
        expect(request.templateFallback).toMatchObject({
          template: 'daily_summary',
          params: { taken: '2', total: '4' },
        });
      } finally {
        await on.close();
      }
    });

    it('is off by default', async () => {
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: '2027-03-12',
        durationDays: 2,
        lastInboundAt: new Date(),
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, ist('2027-03-12', '06:00')))!,
        ist('2027-03-12', '06:00'),
      );
      const stats = await h.planner.planAll(ist('2027-03-12', '21:35'));
      expect(stats.summariesSent).toBe(0);
    });
  });

  describe('custom times ("Time badlo")', () => {
    it('replaces the default times and rejects too few', async () => {
      const day = '2027-02-10';
      const t0 = ist(day, '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: day,
        durationDays: 3,
        lastInboundAt: t0,
      });
      const tooFew = await h.schedules.planWithCustomTimes(rx.userId, rx.documentId, ['07:00'], t0);
      expect(tooFew).toEqual({ ok: false, reason: 'too_few', needed: 2 });
      const ok = await h.schedules.planWithCustomTimes(
        rx.userId,
        rx.documentId,
        ['07:00', '22:00'],
        t0,
      );
      expect(ok && ok.ok && ok.plan.planned.map((item) => item.times)).toEqual([
        ['07:00', '22:00'],
        ['07:00', '22:00'],
      ]);
      await h.schedules.create(
        rx.userId,
        (ok as { plan: Parameters<Harness['schedules']['create']>[1] }).plan,
        t0,
      );
      expect(h.queue.forUser(rx.userId).length).toBeGreaterThan(0);
      const first = await h.prisma.reminder.findFirstOrThrow({
        where: { userId: rx.userId },
        orderBy: { scheduledAt: 'asc' },
      });
      expect(first.scheduledAt.toISOString()).toBe('2027-02-10T01:30:00.000Z'); // 07:00 IST
    });

    it('changing times cancels what was planned for the old ones', async () => {
      const day = '2027-02-12';
      const t0 = ist(day, '06:00');
      const rx = await createUserWithPrescription(h.prisma, {
        startDate: day,
        durationDays: 3,
        lastInboundAt: t0,
      });
      await h.schedules.create(
        rx.userId,
        (await h.schedules.plan(rx.userId, rx.documentId, t0))!,
        t0,
      );
      const custom = await h.schedules.planWithCustomTimes(
        rx.userId,
        rx.documentId,
        ['07:00', '22:00'],
        t0,
      );
      await h.schedules.create(
        rx.userId,
        (custom as { plan: Parameters<Harness['schedules']['create']>[1] }).plan,
        t0,
      );
      const pending = await h.prisma.reminder.findMany({
        where: { userId: rx.userId, status: 'pending' },
      });
      expect(pending.map((row) => localTimeOf(row.scheduledAt, IST))).not.toContain('08:00');
      expect(pending.map((row) => localTimeOf(row.scheduledAt, IST))).toContain('07:00');
    });
  });
});
