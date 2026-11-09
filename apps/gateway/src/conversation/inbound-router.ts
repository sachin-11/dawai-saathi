import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { EchoBotService } from '../dev/echo-bot.service';
import { ReminderAckService } from '../reminders/reminder-ack.service';
import type { InboundJobData } from '../queues/queue.constants';
import { type UserState, UsersService } from '../users/users.service';
import type { DetectedCommand } from '../ai-client/types';
import { AiProcessor } from './ai-processor.service';
import { CommandHandlersService } from './command-handlers.service';
import { BUTTON_ID } from './commands';
import { DeletionFlowService } from './deletion-flow.service';
import { OnboardingService } from './onboarding.service';
import { CaregiverFlowService } from './caregiver-flow.service';
import { PendingInputService } from './pending-input.service';
import { ReminderFlowService } from './reminder-flow.service';
import { InteractionFlowService, parseIxButton } from './interaction-flow.service';
import { LabActionsService, parseLabButton, parseRepButton } from './lab-actions.service';
import { parseRxButton, RxActionsService } from './rx-actions.service';
import { RepliesService, type ReplySession } from './replies.service';
import { LIMIT_NOTICE, type MessageKind, RateLimitService } from '../limits/rate-limit.service';

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
  | 'interaction_check'
  | 'interaction_details'
  | 'lab_all'
  | 'lab_wrong'
  | 'lab_not_found'
  | 'reports_list'
  | 'reports_none'
  | 'report_shown'
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
  | 'unsupported'
  | 'voice_notice'
  | 'voice_notice_answered'
  | 'voice_replies_changed'
  | 'voice_command'
  | 'rate_limited'
  | 'blocked'
  | 'user_cost_capped';

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
    private readonly interactionFlow: InteractionFlowService,
    private readonly labActions: LabActionsService,
    private readonly reminderFlow: ReminderFlowService,
    private readonly caregiverFlow: CaregiverFlowService,
    private readonly pendingInput: PendingInputService,
    private readonly acks: ReminderAckService,
    private readonly echoBot: EchoBotService,
    private readonly aiProcessor: AiProcessor,
    private readonly rateLimit: RateLimitService,
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
      receivedAt: job.receivedAt,
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

    // 2b. Blocked users and rate limits (M15). The emergency check, DELETE and HELP ran above, so
    // neither a block nor a limit can ever stop them.
    const gated = await this.gate(user, job, session, now);
    if (gated) return gated;

    // 3. Onboarding gate.
    if (user.onboardingStep !== 'done') {
      await this.onboarding.handle(user, job, session);
      return 'onboarding';
    }

    // 4. Commands for onboarded users.
    return this.routeActiveUser(user, job, session);
  }

  /** Block and per-user limits. One notice, then silence; retries of the same message count once. */
  private async gate(
    user: UserState,
    job: InboundJobData,
    session: ReplySession,
    now: Date,
  ): Promise<RouteOutcome | null> {
    if (user.blockedUntil && user.blockedUntil.getTime() > now.getTime()) {
      if (await this.rateLimit.noticeForBlock(user.id, user.blockedUntil, now.getTime())) {
        await session.text('blocked.notice');
      }
      return 'blocked';
    }
    const kind: MessageKind =
      job.type === 'audio'
        ? 'voice'
        : job.type === 'image' || job.type === 'document'
          ? 'document'
          : 'text';
    const decision = await this.rateLimit.checkMessage(user.id, kind, now.getTime(), job.messageId);
    if (decision.allowed) return null;
    if (decision.notify) await session.text(LIMIT_NOTICE[decision.scope]);
    if (decision.blocked) await session.text('blocked.notice');
    return 'rate_limited';
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
      await session.text('consent.v2.accepted_welcome');
      return 'welcome_replay';
    }
    if (buttonId === BUTTON_ID.voiceOk || buttonId === BUTTON_ID.voiceNo) {
      await this.commands.answerVoiceNotice(user, buttonId === BUTTON_ID.voiceOk, session);
      return 'voice_notice_answered';
    }
    if (command === 'voice_on' || command === 'voice_off') {
      await this.commands.setVoiceReplies(user, command === 'voice_on', session);
      return 'voice_replies_changed';
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
    if (command === 'reports') {
      return this.labActions.list(user, session);
    }
    if (command === 'check') {
      await this.interactionFlow.check(user, session);
      return 'interaction_check';
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

    // M11: `ix:details:<document id>` under a prescription reply or after CHECK.
    const ixButton = buttonId ? parseIxButton(buttonId) : null;
    if (ixButton) {
      await this.interactionFlow.details(user, ixButton, session);
      return 'interaction_details';
    }

    // M12: `lab:all:<id>` / `lab:wrong:<id>` under a lab reply, `rep:show:<id>` / `rep:page:<n>` from REPORTS.
    const labButton = buttonId ? parseLabButton(buttonId) : null;
    if (labButton) {
      return this.labActions.handle(user, labButton, session);
    }
    const repButton = buttonId ? parseRepButton(buttonId) : null;
    if (repButton) {
      return this.labActions.handleRep(user, repButton, session);
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
    const result = await this.aiProcessor.handle(user, job, session);
    if (typeof result === 'object') {
      return this.runVoiceCommand(user, result.command, session);
    }
    return result;
  }

  /**
   * M13: a command the AI service heard in a voice note. The same handlers as the typed commands, with
   * two safety rules: DELETE only shows the confirmation BUTTON (a transcript alone never erases
   * anything), and caregiver changes are never detected by voice (they need a number or a name).
   */
  private async runVoiceCommand(
    user: UserState,
    command: DetectedCommand,
    session: ReplySession,
  ): Promise<RouteOutcome> {
    switch (command) {
      case 'help':
        await this.commands.help(session);
        break;
      case 'language':
        await this.commands.askLanguage(session);
        break;
      case 'delete':
        await this.deletion.request(user, session);
        break;
      case 'stop_reminders':
      case 'start_reminders':
        await this.commands.setReminders(user, command === 'start_reminders', session);
        break;
      case 'meds':
        await this.commands.meds(user, session);
        break;
      case 'check':
        await this.interactionFlow.check(user, session);
        break;
      case 'reports':
        await this.labActions.list(user, session);
        break;
      case 'reminders':
        await this.reminderFlow.list(user, session);
        break;
      case 'voice_on':
      case 'voice_off':
        await this.commands.setVoiceReplies(user, command === 'voice_on', session);
        break;
      case 'reminder_taken':
      case 'reminder_snooze':
      case 'reminder_skip': {
        // Same rule as the typed "le li": only an answer while a reminder is open (last 2 hours).
        const kind =
          command === 'reminder_taken'
            ? 'taken'
            : command === 'reminder_snooze'
              ? 'snooze'
              : 'skip';
        const outcome = await this.acks.handleText(user.id, kind, session);
        if (outcome === null) await session.text('voice.no_open_reminder');
        break;
      }
      default:
        await session.text('voice.command_unavailable');
    }
    return 'voice_command';
  }
}
