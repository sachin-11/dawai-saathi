import { Injectable } from '@nestjs/common';

import { AiClient, toRequestId } from '../ai-client/ai-client';
import { AuditService } from '../audit/audit.service';
import { PrescriptionService } from '../documents/prescription.service';
import { ReminderScheduleService } from '../reminders/reminder-schedule.service';
import type { UserState } from '../users/users.service';
import { AI_ERROR_REPLY_INDEX } from './ai-processor.service';
import { ReminderFlowService } from './reminder-flow.service';
import type { ReplySession } from './replies.service';

export type RxAction = 'reminders' | 'generic' | 'wrong';

export interface RxButton {
  action: RxAction;
  documentId: string;
}

const RX_BUTTON = /^rx:(reminders|generic|wrong):([^:\s]{1,64})$/;

/** `rx:wrong:<document id>` -> `{action, documentId}`; anything else (also a malformed id) -> null. */
export function parseRxButton(buttonId: string): RxButton | null {
  const match = RX_BUTTON.exec(buttonId);
  return match ? { action: match[1] as RxAction, documentId: match[2] as string } : null;
}

export type RxOutcome =
  'rx_wrong' | 'rx_reminders' | 'rx_not_found' | 'rx_generic_details' | 'rx_generic_unavailable';

/**
 * The three buttons under a prescription reply (CLAUDE.md §7.2 step 4):
 *   Set reminders      -> the reminder set-up flow (M10): summary, confirm, change times
 *   Generic medicines  -> the stored suggestions, rendered by the AI service (M8)
 *   Something is wrong -> the document needs review, its medicines are switched off, audited
 */
@Injectable()
export class RxActionsService {
  constructor(
    private readonly prescriptions: PrescriptionService,
    private readonly audit: AuditService,
    private readonly ai: AiClient,
    private readonly reminderFlow: ReminderFlowService,
    private readonly schedules: ReminderScheduleService,
  ) {}

  async handle(user: UserState, button: RxButton, session: ReplySession): Promise<RxOutcome> {
    if (button.action === 'reminders') {
      await this.reminderFlow.start(user, button.documentId, session);
      return 'rx_reminders';
    }
    if (button.action === 'generic') {
      return this.genericDetails(user, button.documentId, session);
    }

    const deactivated = await this.prescriptions.markWrong(user.id, button.documentId);
    if (deactivated === null) {
      // Unknown id, or another user's document: the same neutral answer, nothing revealed.
      await session.text('rx.not_found');
      return 'rx_not_found';
    }
    // The prescription is "wrong": its reminders must stop too (queued jobs included).
    await this.schedules.cancelForDocument(user.id, button.documentId);
    // Counts only: the audit log never carries ids of documents or any text (CLAUDE.md §12).
    await this.audit.log({
      actor: 'user',
      userId: user.id,
      action: 'rx_reported_wrong',
      metadata: { medications_deactivated: deactivated },
    });
    await session.text('rx.wrong_ack');
    return 'rx_wrong';
  }

  /**
   * "Generic medicines": the suggestions were computed when the prescription was read and stored with
   * it; the AI service only renders them (and checks every brand and rupee amount against them).
   */
  private async genericDetails(
    user: UserState,
    documentId: string,
    session: ReplySession,
  ): Promise<RxOutcome> {
    const items = await this.prescriptions.genericItems(user.id, documentId);
    if (items === null) {
      await session.text('rx.not_found');
      return 'rx_not_found';
    }
    if (items.length === 0 || items.every((item) => item.generic === null)) {
      // Read before M8 (no suggestions stored) or nothing matched: say so instead of an empty list.
      await session.text('rx.generic_unavailable');
      return 'rx_generic_unavailable';
    }
    try {
      const response = await this.ai.genericDetails({
        request_id: toRequestId(`${session.requestId}-generic`),
        language: user.language,
        medicines: items,
      });
      await session.rawText(response.reply.text);
    } catch (error) {
      // One user-visible error per tap (fixed reply index), then let BullMQ retry the job.
      await session.textAt(AI_ERROR_REPLY_INDEX, 'common.error_try_again').catch(() => undefined);
      throw error;
    }
    return 'rx_generic_details';
  }
}
