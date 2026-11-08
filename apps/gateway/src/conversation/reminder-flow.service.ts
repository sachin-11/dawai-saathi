import { Inject, Injectable } from '@nestjs/common';

import { CaregiversService } from '../caregivers/caregivers.service';
import { PendingStore } from '../common/pending/pending.store';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import type { MessageKey } from '../messaging/i18n/i18n.service';
import { parseReminderButton } from '../reminders/ack-parser';
import { ReminderAckService } from '../reminders/reminder-ack.service';
import { ReminderScheduleService, type SchedulePlan } from '../reminders/reminder-schedule.service';
import { localDateOf, localTimeOf } from '../reminders/clock';
import { parseCustomTimes } from '../reminders/time-parser';
import type { UserState } from '../users/users.service';
import { BUTTON_ID } from './commands';
import type { ReplySession } from './replies.service';

const FLOW_BUTTON = /^rem:(confirm|change|cancel|pause|resume):([0-9a-f-]{36})$/i;
const PAGE_BUTTON = /^rem:page:(\d{1,2})$/;

export type FlowOutcome =
  | 'rem_preview'
  | 'rem_nothing'
  | 'rem_confirmed'
  | 'rem_change_prompt'
  | 'rem_times_set'
  | 'rem_times_rejected'
  | 'rem_cancelled'
  | 'rem_list'
  | 'rem_paused'
  | 'rem_resumed'
  | 'rem_ack'
  | 'rem_renewed'
  | 'rem_renew_declined'
  | 'rem_not_found'
  | 'rem_expired';

export function flowButtonId(
  action: 'confirm' | 'change' | 'cancel' | 'pause' | 'resume',
  id: string,
): string {
  return `rem:${action}:${id}`;
}

const MAX_BUTTON_TITLE = 20;
const MAX_BODY = 1000;
const INPUT_KIND = 'rem_times';

/** The conversation side of reminders: set-up after a prescription, "Time badlo", list/pause, answers. */
@Injectable()
export class ReminderFlowService {
  constructor(
    private readonly schedules: ReminderScheduleService,
    private readonly acks: ReminderAckService,
    private readonly caregivers: CaregiversService,
    private readonly pending: PendingStore,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  /** Is this button one of ours? (`rem:...`) */
  static isReminderButton(buttonId: string): boolean {
    return (
      parseReminderButton(buttonId) !== null ||
      FLOW_BUTTON.test(buttonId) ||
      PAGE_BUTTON.test(buttonId) ||
      buttonId === BUTTON_ID.renewYes ||
      buttonId === BUTTON_ID.renewNo
    );
  }

  async handleButton(
    user: UserState,
    buttonId: string,
    session: ReplySession,
    now: Date = new Date(),
  ): Promise<FlowOutcome> {
    const ack = parseReminderButton(buttonId);
    if (ack) {
      await this.acks.handleButton(user.id, ack.kind, ack.epoch, session, now);
      return 'rem_ack';
    }
    const flow = FLOW_BUTTON.exec(buttonId);
    if (flow) {
      const action = (flow[1] as string).toLowerCase();
      const id = flow[2] as string;
      switch (action) {
        case 'confirm':
          return this.confirm(user, id, session, now);
        case 'change':
          return this.askTimes(user, id, session, now);
        case 'cancel':
          return this.cancel(user, session);
        case 'pause':
          return this.pauseResume(user, id, true, session, now);
        default:
          return this.pauseResume(user, id, false, session, now);
      }
    }
    const page = PAGE_BUTTON.exec(buttonId);
    if (page) return this.list(user, session, Number(page[1]), now);
    return this.renew(user, buttonId === BUTTON_ID.renewYes, session, now);
  }

  // ------------------------------------------------------------------ set-up after a prescription

  /** `rx:reminders:<document id>`: show what would be set and ask. */
  async start(
    user: UserState,
    documentId: string,
    session: ReplySession,
    now: Date = new Date(),
  ): Promise<FlowOutcome> {
    const plan = await this.schedules.plan(user.id, documentId, now);
    if (!plan) {
      await session.text('rx.not_found');
      return 'rem_not_found';
    }
    await this.pending.clear('rem_plan', user.id);
    return this.showPlan(plan, session);
  }

  private skippedText(plan: SchedulePlan, session: ReplySession): string {
    if (plan.skipped.length === 0) return '';
    const lines = plan.skipped.map((item) =>
      item.name === null
        ? session.translate('reminders.skipped_line', {
            name: session.translate('reminders.unclear_item'),
            reason: session.translate('reminders.reason.not_active'),
          })
        : session.translate('reminders.skipped_line', {
            name: item.name,
            reason: session.translate(`reminders.reason.${item.reason}` as MessageKey),
          }),
    );
    return `${session.translate('reminders.skipped_header')}\n${lines.join('\n')}`;
  }

  private async showPlan(plan: SchedulePlan, session: ReplySession): Promise<FlowOutcome> {
    const skipped = this.skippedText(plan, session);
    if (plan.planned.length === 0) {
      await session.text('reminders.nothing_eligible', { skipped });
      return 'rem_nothing';
    }
    const lines = plan.planned
      .map((item) =>
        session.translate('reminders.confirm_line', {
          name: item.name,
          times: item.times.join(', '),
          days: item.openEnded
            ? session.translate('reminders.days_open', { count: this.env.REMINDER_OPEN_ENDED_DAYS })
            : session.translate('reminders.days_n', {
                count: daysBetween(item.startDate, item.endDate),
              }),
        }),
      )
      .join('\n');
    const buttons = [
      { id: flowButtonId('confirm', plan.documentId), titleKey: 'reminders.btn.confirm' as const },
      { id: flowButtonId('change', plan.documentId), titleKey: 'reminders.btn.change' as const },
      { id: flowButtonId('cancel', plan.documentId), titleKey: 'reminders.btn.cancel' as const },
    ];
    const params = { lines, skipped };
    const body = session.translate('reminders.confirm_body', params);
    if (body.length > MAX_BODY) {
      // A button body holds 1024 characters: send the text, then the buttons under a short prompt.
      await session.rawText(body);
      await session.buttons('common.next_step', {}, buttons);
    } else {
      await session.buttons('reminders.confirm_body', params, buttons);
    }
    return 'rem_preview';
  }

  private async askTimes(
    user: UserState,
    documentId: string,
    session: ReplySession,
    now: Date,
  ): Promise<FlowOutcome> {
    const plan = await this.schedules.plan(user.id, documentId, now);
    if (!plan) {
      await session.text('rx.not_found');
      return 'rem_not_found';
    }
    await this.pending.setValue(
      'input',
      user.id,
      JSON.stringify({ kind: INPUT_KIND, ref: documentId }),
    );
    await session.text('reminders.change_prompt');
    return 'rem_change_prompt';
  }

  /** The user's free-text answer to "Time badlo" (read from Redis by the router). */
  async handleTimesInput(
    user: UserState,
    documentId: string,
    text: string,
    session: ReplySession,
    now: Date = new Date(),
  ): Promise<FlowOutcome> {
    const parsed = parseCustomTimes(text);
    if (!parsed.ok) {
      // Keep waiting: the user can try again.
      await session.text(
        parsed.reason === 'ambiguous' ? 'reminders.change_ambiguous' : 'reminders.change_invalid',
      );
      return 'rem_times_rejected';
    }
    const result = await this.schedules.planWithCustomTimes(user.id, documentId, parsed.times, now);
    if (!result) {
      await this.pending.clear('input', user.id);
      await session.text('reminders.change_expired');
      return 'rem_expired';
    }
    if (!result.ok) {
      await session.text('reminders.change_too_few', {
        given: parsed.times.length,
        needed: result.needed,
      });
      return 'rem_times_rejected';
    }
    await this.pending.setValue(
      'rem_plan',
      user.id,
      JSON.stringify({ documentId, times: parsed.times }),
    );
    await this.pending.clear('input', user.id);
    await this.showPlan(result.plan, session);
    return 'rem_times_set';
  }

  private async confirm(
    user: UserState,
    documentId: string,
    session: ReplySession,
    now: Date,
  ): Promise<FlowOutcome> {
    const custom = await this.readCustomTimes(user.id, documentId);
    const plan = custom
      ? ((await this.schedules.planWithCustomTimes(user.id, documentId, custom, now)) ?? null)
      : await this.schedules.plan(user.id, documentId, now);
    const resolved = plan && 'ok' in plan ? (plan.ok ? plan.plan : null) : plan;
    if (!resolved) {
      await session.text('reminders.change_expired');
      return 'rem_expired';
    }
    if (resolved.planned.length === 0) {
      await session.text('reminders.nothing_eligible', {
        skipped: this.skippedText(resolved, session),
      });
      return 'rem_nothing';
    }
    const created = await this.schedules.create(user.id, resolved, now);
    await this.pending.clear('rem_plan', user.id);
    await session.text('reminders.set_done', {
      first: created.firstSlot ? this.describe(created.firstSlot, now) : '–',
    });
    if (!user.remindersEnabled) await session.text('reminders.set_but_off');
    return 'rem_confirmed';
  }

  private async cancel(user: UserState, session: ReplySession): Promise<FlowOutcome> {
    await this.pending.clear('rem_plan', user.id);
    await this.pending.clear('input', user.id);
    await session.text('reminders.cancelled');
    return 'rem_cancelled';
  }

  private async readCustomTimes(userId: string, documentId: string): Promise<string[] | null> {
    const raw = await this.pending.getValue('rem_plan', userId);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { documentId?: string; times?: string[] };
      return value.documentId === documentId && Array.isArray(value.times) ? value.times : null;
    } catch {
      return null;
    }
  }

  private describe(slot: Date, now: Date): string {
    const tz = 'Asia/Kolkata';
    const time = localTimeOf(slot, tz);
    const day = localDateOf(slot, tz);
    return day === localDateOf(now, tz) ? time : `${day} ${time}`;
  }

  // ------------------------------------------------------------------ REMINDERS list + pause/resume

  async list(
    user: UserState,
    session: ReplySession,
    page = 0,
    now: Date = new Date(),
  ): Promise<FlowOutcome> {
    const schedules = await this.schedules.list(user.id, now);
    if (schedules.length === 0) {
      await session.text('reminders.list_none');
      return 'rem_list';
    }
    const care = await this.caregivers.summary(user.id);
    const lines = schedules.map((schedule) =>
      session.translate('reminders.list_line', {
        name: schedule.name,
        times: schedule.times.join(', '),
        status: session.translate(
          `reminders.status.${schedule.status === 'paused' ? 'paused' : 'active'}`,
        ),
      }),
    );
    const extra =
      care.verified + care.pending > 0
        ? [
            session.translate('reminders.caregiver_line', {
              verified: care.verified,
              pending: care.pending,
            }),
          ]
        : [];
    const body = [session.translate('reminders.list_header'), ...lines, ...extra].join('\n');

    // At most 3 buttons per message: 3 medicines on the last page, otherwise 2 plus "More".
    const { start, size } = pageSlice(schedules.length, page);
    const slice = schedules.slice(start, start + size);
    const hasMore = start + size < schedules.length;
    const buttons = slice.map((schedule) => ({
      id: flowButtonId(schedule.status === 'paused' ? 'resume' : 'pause', schedule.id),
      title: session
        .translate(schedule.status === 'paused' ? 'reminders.btn.resume' : 'reminders.btn.pause', {
          name: schedule.name,
        })
        .slice(0, MAX_BUTTON_TITLE),
    }));
    if (hasMore)
      buttons.push({ id: `rem:page:${page + 1}`, title: session.translate('reminders.list_more') });

    if (body.length > MAX_BODY) {
      await session.rawText(body);
      await session.rawButtonsWithPrompt('reminders.list_pick', buttons);
    } else {
      await session.rawButtons(body, buttons);
    }
    return 'rem_list';
  }

  private async pauseResume(
    user: UserState,
    scheduleId: string,
    pause: boolean,
    session: ReplySession,
    now: Date,
  ): Promise<FlowOutcome> {
    const changed = pause
      ? await this.schedules.pauseOne(user.id, scheduleId)
      : await this.schedules.resumeOne(user.id, scheduleId, now);
    if (!changed) {
      await session.text('rx.not_found');
      return 'rem_not_found';
    }
    await session.text(pause ? 'reminders.paused_one' : 'reminders.resumed_one');
    return pause ? 'rem_paused' : 'rem_resumed';
  }

  private async renew(
    user: UserState,
    yes: boolean,
    session: ReplySession,
    now: Date,
  ): Promise<FlowOutcome> {
    if (!yes) {
      await session.text('reminder.renew_no');
      return 'rem_renew_declined';
    }
    const until = await this.schedules.renew(user.id, now);
    if (!until) {
      await session.text('reminder.expired');
      return 'rem_not_found';
    }
    await session.text('reminder.renew_done', { date: until });
    return 'rem_renewed';
  }
}

/** Page `page` of `total` items when a page holds 3 (the last one) or 2 + a "More" button. */
export function pageSlice(total: number, page: number): { start: number; size: number } {
  let start = 0;
  for (let index = 0; index < page && start < total; index += 1) {
    start += total - start <= 3 ? total - start : 2;
  }
  return { start, size: total - start <= 3 ? Math.max(0, total - start) : 2 };
}

function daysBetween(start: string, end: string): number {
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  );
}
