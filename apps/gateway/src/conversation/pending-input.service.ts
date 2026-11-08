import { Injectable } from '@nestjs/common';

import { CryptoService } from '../common/crypto/crypto.service';
import { PendingStore } from '../common/pending/pending.store';
import type { UserState } from '../users/users.service';
import { CaregiverFlowService } from './caregiver-flow.service';
import { ReminderFlowService } from './reminder-flow.service';
import type { ReplySession } from './replies.service';

/**
 * Free-text answers to a question we asked ("which times?", "what do they call you?").
 *
 * The queue carries no text (CLAUDE.md §2.6). While a question is open (Redis `pending:input:<user>`,
 * 10 minutes), the webhook keeps the user's next text, encrypted, under `pending:input_text:<user>`
 * and sets the `input` signal. This service reads it ONCE and hands it to the right flow.
 */
@Injectable()
export class PendingInputService {
  constructor(
    private readonly pending: PendingStore,
    private readonly crypto: CryptoService,
    private readonly reminderFlow: ReminderFlowService,
    private readonly caregiverFlow: CaregiverFlowService,
  ) {}

  /** The outcome name, or null when nothing was waiting any more (the text then takes the normal path). */
  async handle(user: UserState, session: ReplySession): Promise<string | null> {
    const [rawInput, rawText] = await Promise.all([
      this.pending.getValue('input', user.id),
      this.pending.getValue('input_text', user.id),
    ]);
    if (!rawInput || !rawText) return null;
    await this.pending.clear('input_text', user.id);

    let input: { kind?: string; ref?: string };
    let text: string;
    try {
      input = JSON.parse(rawInput) as { kind?: string; ref?: string };
      text = this.crypto.decrypt(rawText);
    } catch {
      return null;
    }

    if (input.kind === 'rem_times' && input.ref) {
      return this.reminderFlow.handleTimesInput(user, input.ref, text, session);
    }
    if (input.kind === 'cg_label') {
      return this.caregiverFlow.handleLabel(user, text, session);
    }
    return null;
  }
}
