import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PrescriptionService } from '../documents/prescription.service';
import type { UserState } from '../users/users.service';
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

export type RxOutcome = 'rx_wrong' | 'rx_coming_soon' | 'rx_not_found';

/**
 * The three buttons under a prescription reply (CLAUDE.md §7.2 step 4):
 *   Set reminders      -> "coming soon" until M10
 *   Generic medicines  -> "coming soon" until M8
 *   Something is wrong -> the document needs review, its medicines are switched off, audited
 */
@Injectable()
export class RxActionsService {
  constructor(
    private readonly prescriptions: PrescriptionService,
    private readonly audit: AuditService,
  ) {}

  async handle(user: UserState, button: RxButton, session: ReplySession): Promise<RxOutcome> {
    if (button.action === 'reminders') {
      await session.text('rx.reminders_soon');
      return 'rx_coming_soon';
    }
    if (button.action === 'generic') {
      await session.text('rx.generic_soon');
      return 'rx_coming_soon';
    }

    const deactivated = await this.prescriptions.markWrong(user.id, button.documentId);
    if (deactivated === null) {
      // Unknown id, or another user's document: the same neutral answer, nothing revealed.
      await session.text('rx.not_found');
      return 'rx_not_found';
    }
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
}
