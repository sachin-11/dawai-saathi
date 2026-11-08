import type { CaregiversService } from '../caregivers/caregivers.service';
import type { PendingStore } from '../common/pending/pending.store';
import type { Env } from '../config/env.schema';
import type { ReminderAckService } from '../reminders/reminder-ack.service';
import type { ReminderScheduleService, SchedulePlan } from '../reminders/reminder-schedule.service';
import type { UserState } from '../users/users.service';
import { pageSlice, ReminderFlowService } from './reminder-flow.service';
import type { ReplySession } from './replies.service';

const DOC = '3f2c1c1e-8d7a-4b57-9d6e-1d6f0a1b2c3d';
const user: UserState = {
  id: 'user-1',
  language: 'en',
  onboardingStep: 'done',
  consentAt: new Date(),
  remindersEnabled: true,
  deletedAt: null,
};
const PLAN: SchedulePlan = {
  documentId: DOC,
  planned: [
    {
      medicationId: 'm1',
      name: 'Dolo 650',
      times: ['08:00', '21:00'],
      startDate: '2026-11-10',
      endDate: '2026-11-14',
      openEnded: false,
    },
  ],
  skipped: [
    { name: 'Crocin SOS', reason: 'as_needed' },
    { name: null, reason: 'not_active' },
  ],
  neededTimes: 2,
};

function setup(plan: SchedulePlan | null = PLAN) {
  const schedules = {
    plan: jest.fn().mockResolvedValue(plan),
    planWithCustomTimes: jest.fn().mockResolvedValue(plan ? { ok: true, plan } : null),
    create: jest
      .fn()
      .mockResolvedValue({ schedules: 1, firstSlot: new Date('2026-11-10T02:30:00Z') }),
    pauseOne: jest.fn().mockResolvedValue(true),
    resumeOne: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    renew: jest.fn().mockResolvedValue('2026-12-10'),
  };
  const acks = { handleButton: jest.fn().mockResolvedValue('taken') };
  const caregivers = { summary: jest.fn().mockResolvedValue({ verified: 0, pending: 0 }) };
  const store = new Map<string, string>();
  const pending = {
    clear: jest.fn().mockImplementation((kind: string, id: string) => {
      store.delete(`${kind}:${id}`);
      return Promise.resolve();
    }),
    setValue: jest.fn().mockImplementation((kind: string, id: string, value: string) => {
      store.set(`${kind}:${id}`, value);
      return Promise.resolve();
    }),
    getValue: jest
      .fn()
      .mockImplementation((kind: string, id: string) =>
        Promise.resolve(store.get(`${kind}:${id}`) ?? null),
      ),
  };
  const session = {
    text: jest.fn().mockResolvedValue(undefined),
    rawText: jest.fn().mockResolvedValue(undefined),
    buttons: jest.fn().mockResolvedValue(undefined),
    rawButtons: jest.fn().mockResolvedValue(undefined),
    rawButtonsWithPrompt: jest.fn().mockResolvedValue(undefined),
    translate: jest
      .fn()
      .mockImplementation(
        (key: string, params: Record<string, unknown> = {}) =>
          `${key}${Object.keys(params).length ? JSON.stringify(params) : ''}`,
      ),
  };
  const service = new ReminderFlowService(
    schedules as unknown as ReminderScheduleService,
    acks as unknown as ReminderAckService,
    caregivers as unknown as CaregiversService,
    pending as unknown as PendingStore,
    { REMINDER_OPEN_ENDED_DAYS: 30 } as Env,
  );
  return {
    service,
    schedules,
    acks,
    pending,
    session,
    store,
    as: session as unknown as ReplySession,
  };
}
const NOW = new Date('2026-11-10T00:30:00Z');

describe('pageSlice', () => {
  it.each([
    [1, 0, 0, 1],
    [3, 0, 0, 3],
    [4, 0, 0, 2],
    [4, 1, 2, 2],
    [5, 0, 0, 2],
    [5, 1, 2, 3],
    [7, 2, 4, 3],
    [2, 5, 2, 0],
  ])('%i items, page %i -> start %i size %i', (total, page, start, size) => {
    expect(pageSlice(total, page)).toEqual({ start, size });
  });
});

describe('ReminderFlowService', () => {
  it('knows its own button ids', () => {
    for (const id of [
      'rem:taken:1794277800',
      `rem:confirm:${DOC}`,
      `rem:change:${DOC}`,
      `rem:cancel:${DOC}`,
      `rem:pause:${DOC}`,
      `rem:resume:${DOC}`,
      'rem:page:2',
      'rem:renew:yes',
      'rem:renew:no',
    ]) {
      expect(ReminderFlowService.isReminderButton(id)).toBe(true);
    }
    for (const id of [
      'rx:reminders:' + DOC,
      'rem:confirm:not-a-uuid',
      'rem:taken:abc',
      'lang:hi',
      'rem:',
    ]) {
      expect(ReminderFlowService.isReminderButton(id)).toBe(false);
    }
  });

  it('start shows the plan with confirm / change / cancel buttons carrying the document id', async () => {
    const s = setup();
    expect(await s.service.start(user, DOC, s.as, NOW)).toBe('rem_preview');
    const [bodyKey, params, buttons] = s.session.buttons.mock.calls[0] as [
      string,
      { lines: string; skipped: string },
      { id: string }[],
    ];
    expect(bodyKey).toBe('reminders.confirm_body');
    expect(params.lines).toContain('Dolo 650');
    expect(params.lines).toContain('08:00, 21:00');
    expect(params.skipped).toContain('Crocin SOS');
    expect(params.skipped).toContain('reminders.unclear_item'); // an unclear medicine is never named
    expect(buttons.map((button) => button.id)).toEqual([
      `rem:confirm:${DOC}`,
      `rem:change:${DOC}`,
      `rem:cancel:${DOC}`,
    ]);
    expect(s.schedules.create).not.toHaveBeenCalled(); // nothing is saved before the user confirms
  });

  it('start for someone else\'s or an unknown document says "not found" and shows nothing', async () => {
    const s = setup(null);
    expect(await s.service.start(user, DOC, s.as, NOW)).toBe('rem_not_found');
    expect(s.session.text).toHaveBeenCalledWith('rx.not_found');
    expect(s.session.buttons).not.toHaveBeenCalled();
  });

  it('when nothing can get a reminder it says why and offers no confirm button', async () => {
    const s = setup({ ...PLAN, planned: [] });
    expect(await s.service.start(user, DOC, s.as, NOW)).toBe('rem_nothing');
    expect(s.session.text).toHaveBeenCalledWith(
      'reminders.nothing_eligible',
      expect.objectContaining({ skipped: expect.any(String) as string }),
    );
    expect(s.session.buttons).not.toHaveBeenCalled();
  });

  it('confirm creates the schedules and tells the first time', async () => {
    const s = setup();
    expect(await s.service.handleButton(user, `rem:confirm:${DOC}`, s.as, NOW)).toBe(
      'rem_confirmed',
    );
    expect(s.schedules.create).toHaveBeenCalledWith('user-1', PLAN, NOW);
    expect(s.session.text).toHaveBeenCalledWith('reminders.set_done', { first: '08:00' });
  });

  it('confirm tells the user when reminders are switched off', async () => {
    const s = setup();
    await s.service.handleButton(
      { ...user, remindersEnabled: false },
      `rem:confirm:${DOC}`,
      s.as,
      NOW,
    );
    expect(s.session.text).toHaveBeenCalledWith('reminders.set_but_off');
  });

  it('cancel saves nothing', async () => {
    const s = setup();
    expect(await s.service.handleButton(user, `rem:cancel:${DOC}`, s.as, NOW)).toBe(
      'rem_cancelled',
    );
    expect(s.schedules.create).not.toHaveBeenCalled();
    expect(s.session.text).toHaveBeenCalledWith('reminders.cancelled');
  });

  describe('Time badlo', () => {
    it('asks for times and opens a pending question', async () => {
      const s = setup();
      expect(await s.service.handleButton(user, `rem:change:${DOC}`, s.as, NOW)).toBe(
        'rem_change_prompt',
      );
      expect(s.pending.setValue).toHaveBeenCalledWith(
        'input',
        'user-1',
        JSON.stringify({ kind: 'rem_times', ref: DOC }),
      );
      expect(s.session.text).toHaveBeenCalledWith('reminders.change_prompt');
    });

    it('a good answer shows the new plan and remembers the times for the confirm tap', async () => {
      const s = setup();
      expect(await s.service.handleTimesInput(user, DOC, 'subah 7, raat 10', s.as, NOW)).toBe(
        'rem_times_set',
      );
      expect(s.schedules.planWithCustomTimes).toHaveBeenCalledWith(
        'user-1',
        DOC,
        ['07:00', '22:00'],
        NOW,
      );
      expect(s.store.get('rem_plan:user-1')).toBe(
        JSON.stringify({ documentId: DOC, times: ['07:00', '22:00'] }),
      );
      expect(s.store.has('input:user-1')).toBe(false);
      expect(s.session.buttons).toHaveBeenCalled();

      // confirm now uses the custom times
      await s.service.handleButton(user, `rem:confirm:${DOC}`, s.as, NOW);
      expect(s.schedules.planWithCustomTimes).toHaveBeenLastCalledWith(
        'user-1',
        DOC,
        ['07:00', '22:00'],
        NOW,
      );
      expect(s.schedules.create).toHaveBeenCalled();
    });

    it('an unclear answer is explained and the question stays open', async () => {
      const s = setup();
      expect(await s.service.handleTimesInput(user, DOC, '7, 10', s.as, NOW)).toBe(
        'rem_times_rejected',
      );
      expect(s.session.text).toHaveBeenCalledWith('reminders.change_ambiguous');
      expect(await s.service.handleTimesInput(user, DOC, 'hello', s.as, NOW)).toBe(
        'rem_times_rejected',
      );
      expect(s.session.text).toHaveBeenLastCalledWith('reminders.change_invalid');
      expect(s.pending.clear).not.toHaveBeenCalledWith('input', 'user-1');
      expect(s.schedules.create).not.toHaveBeenCalled();
    });

    it('too few times for a medicine are rejected with the number needed', async () => {
      const s = setup();
      s.schedules.planWithCustomTimes.mockResolvedValue({
        ok: false,
        reason: 'too_few',
        needed: 2,
      });
      expect(await s.service.handleTimesInput(user, DOC, 'subah 7', s.as, NOW)).toBe(
        'rem_times_rejected',
      );
      expect(s.session.text).toHaveBeenCalledWith('reminders.change_too_few', {
        given: 1,
        needed: 2,
      });
    });
  });

  it("pause / resume buttons call the schedule service for the user's own schedule", async () => {
    const s = setup();
    expect(await s.service.handleButton(user, `rem:pause:${DOC}`, s.as, NOW)).toBe('rem_paused');
    expect(s.schedules.pauseOne).toHaveBeenCalledWith('user-1', DOC);
    expect(await s.service.handleButton(user, `rem:resume:${DOC}`, s.as, NOW)).toBe('rem_resumed');
    s.schedules.pauseOne.mockResolvedValue(false);
    expect(await s.service.handleButton(user, `rem:pause:${DOC}`, s.as, NOW)).toBe('rem_not_found');
  });

  it('list pages the pause buttons: at most 3 per message, "More" when there are more', async () => {
    const s = setup();
    const schedule = (n: number) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      name: `Medicine ${n} with a very long name`,
      times: ['08:00'],
      status: n === 2 ? 'paused' : 'active',
      timezone: 'Asia/Kolkata',
      today: '2026-11-10',
    });
    s.schedules.list.mockResolvedValue([1, 2, 3, 4, 5].map(schedule));
    await s.service.list(user, s.as, 0, NOW);
    const first = s.session.rawButtons.mock.calls[0]?.[1] as { id: string; title: string }[];
    expect(first).toHaveLength(3);
    expect(first.slice(0, 2).map((button) => button.id.split(':')[1])).toEqual(['pause', 'resume']);
    expect(first[2]).toEqual({ id: 'rem:page:1', title: 'reminders.list_more' });
    expect(first.every((button) => button.title.length <= 20)).toBe(true);

    await s.service.list(user, s.as, 1, NOW);
    const second = s.session.rawButtons.mock.calls[1]?.[1] as { id: string }[];
    expect(second).toHaveLength(3);
    expect(second.every((button) => !button.id.startsWith('rem:page'))).toBe(true);
  });

  it('renew extends the schedules or says the question is no longer open', async () => {
    const s = setup();
    expect(await s.service.handleButton(user, 'rem:renew:yes', s.as, NOW)).toBe('rem_renewed');
    expect(s.session.text).toHaveBeenCalledWith('reminder.renew_done', { date: '2026-12-10' });
    s.schedules.renew.mockResolvedValue(null);
    expect(await s.service.handleButton(user, 'rem:renew:yes', s.as, NOW)).toBe('rem_not_found');
    expect(await s.service.handleButton(user, 'rem:renew:no', s.as, NOW)).toBe(
      'rem_renew_declined',
    );
  });

  it('a reminder button goes to the ack service with the slot from the id', async () => {
    const s = setup();
    expect(await s.service.handleButton(user, 'rem:taken:1794277800', s.as, NOW)).toBe('rem_ack');
    expect(s.acks.handleButton).toHaveBeenCalledWith('user-1', 'taken', 1794277800, s.as, NOW);
  });
});
