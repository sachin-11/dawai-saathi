import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { EchoBotService } from '../dev/echo-bot.service';
import { ReminderAckService } from '../reminders/reminder-ack.service';
import type { InboundJobData } from '../queues/queue.constants';
import { type UserState, UsersService } from '../users/users.service';
import { AiProcessor } from './ai-processor.service';
import { CommandHandlersService } from './command-handlers.service';
import { BUTTON_ID } from './commands';
import { DeletionFlowService } from './deletion-flow.service';
import { OnboardingService } from './onboarding.service';
import { CaregiverFlowService } from './caregiver-flow.service';
import { PendingInputService } from './pending-input.service';
import { ReminderFlowService } from './reminder-flow.service';
import { parseRxButton, RxActionsService } from './rx-actions.service';
import { RepliesService, type ReplySession } from './replies.service';

/**
 * While an erasure job runs the user is ignored. If that job ever got stuck, this window makes sure
 * the user is not silenced forever.
 */
export const DELETION_MARKER_TTL_MS = 15 * 60 * 1000;

export type RouteOutcome =
  | 'ignored_unknown_user'
  | 'ignored_deletion_pending'
  | 'emergency'
  | 'delete_confirm'
  | 'delete_cancel'
  | 'delete_request'
  | 'help'
  | 'onboarding'
  | 'welcome_replay'
  | 'language_prompt'
  | 'language_changed'
  | 'reminders_stopped'
  | 'reminders_started'
  | 'meds'
  | 'rx_wrong'
  | 'rx_reminders'
  | 'reminder_ack_text'
  | 'reminders_list'
  | 'input_handled'
  | 'caregiver'
  | 'reminder_flow'
  | 'rx_not_found'
  | 'rx_generic_details'
  | 'rx_generic_unavailable'
  | 'echo_bot'
  | 'ai_reply'
  | 'ai_emergency'
  | 'media_rejected'
  | 'unsupported';

/**
 * Single entry point for every inbound message after the webhook has stored it (CLAUDE.md §7).
 *
 * The ORDER is the safety design:
 *   1. emergency  — for everyone, even before consent, even before a language is chosen
 *   2. DELETE / HELP and the delete buttons — work in every onboarding step
 *   3. onboarding — until it is `done`, nothing else happens (no media download, no processing)
 *   4. commands for onboarded users — LANGUAGE, STOP/START REMINDERS, MEDS, prescription buttons
 *   5. everything else — the dev echo bot (if enabled) or the AI service (M5)
 *
 * The router never sees message text: the webhook turns it into `signals` (emergency / command)
 * and buttons are matched by id. Collaborators are injected, so every branch is unit-testable.
 */
@Injectable()
export class InboundRouter {
  constructor(
    private readonly users: UsersService,
    private readonly replies: RepliesService,
    private readonly onboarding: OnboardingService,
    private readonly commands: CommandHandlersService,
    private readonly deletion: DeletionFlowService,
    private readonly rxActions: RxActionsService,
    private readonly reminderFlow: ReminderFlowService,
    private readonly caregiverFlow: CaregiverFlowService,
    private readonly pendingInput: PendingInputService,
    private readonly acks: ReminderAckService,
    private readonly echoBot: EchoBotService,
    private readonly aiProcessor: AiProcessor,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InboundRouter.name);
  }

  async route(job: InboundJobData, now: Date = new Date()): Promise<RouteOutcome> {
    const user = await this.users.getState(job.userId);
    if (!user) {
      this.logger.info({ request_id: job.requestId }, 'message for an erased user, ignoring');
      return 'ignored_unknown_user';
    }
    if (user.deletedAt && now.getTime() - user.deletedAt.getTime() < DELETION_MARKER_TTL_MS) {
      return 'ignored_deletion_pending';
    }

    const session = this.replies.session({
      userId: user.id,
      language: user.language,
      messageId: job.messageId,
      requestId: job.requestId,
    });
    const buttonId = job.button?.id;
    const command = job.signals?.command;

    // 1. Emergency: before everything else, before consent.
    if (job.signals?.emergency) {
      await session.emergency(job.signals.emergency, user.onboardingStep === 'language');
      return 'emergency';
    }

    // 2. Global: DELETE (and its buttons) and HELP, in every step.
    if (buttonId === BUTTON_ID.deleteConfirm) {
      await this.deletion.confirm(user, session);
      return 'delete_confirm';
    }
    if (buttonId === BUTTON_ID.deleteCancel) {
      await this.deletion.cancel(user, session);
      return 'delete_cancel';
    }
    if (command === 'delete') {
      await this.deletion.request(user, session);
      return 'delete_request';
    }
    if (command === 'help') {
      await this.commands.help(session);
      return 'help';
    }

    // 3. Onboarding gate.
    if (user.onboardingStep !== 'done') {
      await this.onboarding.handle(user, job, session);
      return 'onboarding';
    }

    // 4. Commands for onboarded users.
    return this.routeActiveUser(user, job, session);
  }

  private async routeActiveUser(
    user: UserState,
    job: InboundJobData,
    session: ReplySession,
  ): Promise<RouteOutcome> {
    const buttonId = job.button?.id;
    const command = job.signals?.command;

    if (buttonId === BUTTON_ID.langHi || buttonId === BUTTON_ID.langEn) {
      await this.commands.setLanguage(user, buttonId === BUTTON_ID.langHi ? 'hi' : 'en', session);
      return 'language_changed';
    }
    if (buttonId === BUTTON_ID.consentYes) {
      // A retried job whose first attempt already finished onboarding lands here: same reply index,
      // so the welcome is not sent twice, but it IS sent if the first attempt died before it.
      await session.text('consent.v1.accepted_welcome');
      return 'welcome_replay';
    }
    if (command === 'language') {
      await this.commands.askLanguage(session);
      return 'language_prompt';
    }
    if (command === 'stop_reminders' || command === 'start_reminders') {
      const enabled = command === 'start_reminders';
      await this.commands.setReminders(user, enabled, session);
      return enabled ? 'reminders_started' : 'reminders_stopped';
    }
    if (command === 'meds') {
      await this.commands.meds(user, session);
      return 'meds';
    }

    // M10: the answer to a question we asked (times, caregiver label) beats everything below it.
    if (job.signals?.input) {
      const handled = await this.pendingInput.handle(user, session);
      if (handled) return 'input_handled';
    }
    if (command === 'reminders') {
      await this.reminderFlow.list(user, session);
      return 'reminders_list';
    }
    if (command === 'caregiver_add') {
      await this.caregiverFlow.startAdd(user, session);
      return 'caregiver';
    }
    if (command === 'caregiver_remove') {
      await this.caregiverFlow.remove(user, session);
      return 'caregiver';
    }
    if (buttonId && ReminderFlowService.isReminderButton(buttonId)) {
      await this.reminderFlow.handleButton(user, buttonId, session);
      return 'reminder_flow';
    }
    // "le li" / "baad me" / "skip" as text: only an answer while a reminder is open (last 2 hours).
    if (job.signals?.ack) {
      const outcome = await this.acks.handleText(user.id, job.signals.ack, session);
      if (outcome !== null) return 'reminder_ack_text';
    }

    // Prescription buttons (`rx:wrong:<document id>` ...): matched by id, never by title.
    const rxButton = buttonId ? parseRxButton(buttonId) : null;
    if (rxButton) {
      return this.rxActions.handle(user, rxButton, session);
    }

    // 5. Everything else.
    if (this.echoBot.enabled) {
      await this.echoBot.handle(job);
      return 'echo_bot';
    }
    return this.aiProcessor.handle(user, job, session);
  }
}
