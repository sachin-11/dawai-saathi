import { Injectable } from '@nestjs/common';

import { cleanLabel, CaregiversService } from '../caregivers/caregivers.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PendingStore } from '../common/pending/pending.store';
import { LIMIT_NOTICE, RateLimitService } from '../limits/rate-limit.service';
import type { UserState } from '../users/users.service';
import type { ReplySession } from './replies.service';

export type CaregiverOutcome =
  | 'cg_usage'
  | 'cg_rejected'
  | 'cg_ask_label'
  | 'cg_label_rejected'
  | 'cg_invited'
  | 'cg_expired'
  | 'cg_removed'
  | 'cg_none'
  | 'cg_limited';

const INPUT_KIND = 'cg_label';

/**
 * The user's side of adding a family contact:
 *   CAREGIVER +91...  -> (webhook keeps the number, encrypted, in Redis) -> checks -> "what do they call you?"
 *   the user's next text -> the label -> invite template to the caregiver
 * The caregiver's YES / NO / STOP ALERTS are handled by the `reminders` worker (CaregiversService).
 */
@Injectable()
export class CaregiverFlowService {
  constructor(
    private readonly caregivers: CaregiversService,
    private readonly pending: PendingStore,
    private readonly crypto: CryptoService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async startAdd(user: UserState, session: ReplySession): Promise<CaregiverOutcome> {
    const stored = await this.pending.getValue('cg_phone', user.id);
    if (!stored) {
      await session.text('caregiver.usage');
      return 'cg_usage';
    }
    const number = this.crypto.decrypt(stored);
    const check = await this.caregivers.checkNewNumber(user.id, number);
    switch (check.result) {
      case 'invalid_number':
        await this.pending.clear('cg_phone', user.id);
        await session.text('caregiver.invalid_number');
        return 'cg_rejected';
      case 'own_number':
        await this.pending.clear('cg_phone', user.id);
        await session.text('caregiver.own_number');
        return 'cg_rejected';
      case 'limit':
        await this.pending.clear('cg_phone', user.id);
        await session.text('caregiver.limit');
        return 'cg_rejected';
      case 'already':
        await this.pending.clear('cg_phone', user.id);
        await session.text('caregiver.already');
        return 'cg_rejected';
      case 'ok':
        await this.pending.setValue('input', user.id, JSON.stringify({ kind: INPUT_KIND }));
        await session.text('caregiver.ask_label');
        return 'cg_ask_label';
    }
  }

  /** The text the user sent while we waited for the label (read from Redis by the router). */
  async handleLabel(
    user: UserState,
    text: string,
    session: ReplySession,
  ): Promise<CaregiverOutcome> {
    const label = cleanLabel(text);
    if (!label) {
      // Keep waiting: the user can try again.
      await session.text('caregiver.label_invalid');
      return 'cg_label_rejected';
    }
    // M15: at most 3 invitations a day (spam / harassment guard). The label is kept for a retry.
    const limit = await this.rateLimit.checkCaregiverInvite(user.id);
    if (!limit.allowed) {
      await this.pending.clear('cg_phone', user.id);
      await this.pending.clear('input', user.id);
      await session.text(LIMIT_NOTICE.caregiver_invites);
      return 'cg_limited';
    }
    const stored = await this.pending.getValue('cg_phone', user.id);
    if (!stored) {
      await this.pending.clear('input', user.id);
      await session.text('caregiver.flow_expired');
      return 'cg_expired';
    }
    const invited = await this.caregivers.invite(
      user.id,
      session.currentLanguage,
      this.crypto.decrypt(stored),
      label,
      session.messageId,
    );
    await this.pending.clear('cg_phone', user.id);
    await this.pending.clear('input', user.id);
    if (!invited) {
      await session.text('caregiver.already');
      return 'cg_rejected';
    }
    await session.text('caregiver.invite_sent');
    return 'cg_invited';
  }

  async remove(user: UserState, session: ReplySession): Promise<CaregiverOutcome> {
    const removed = await this.caregivers.remove(user.id);
    await session.text(removed > 0 ? 'caregiver.removed' : 'caregiver.none_to_remove');
    return removed > 0 ? 'cg_removed' : 'cg_none';
  }
}
