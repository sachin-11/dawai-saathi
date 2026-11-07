import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PendingStore } from '../common/pending/pending.store';
import { UserDeletionQueue } from '../deletion/user-deletion.queue';
import { type UserState, UsersService } from '../users/users.service';
import { BUTTON_ID } from './commands';
import type { ButtonSpec, ReplySession } from './replies.service';

const DELETE_BUTTONS: readonly ButtonSpec[] = [
  { id: BUTTON_ID.deleteConfirm, titleKey: 'buttons.delete_yes' },
  { id: BUTTON_ID.deleteCancel, titleKey: 'buttons.delete_no' },
];

/**
 * The conversational part of DELETE: ask, confirm (with a 5-minute window), then hand over to the
 * `user-deletion` job. Nothing is deleted without an explicit, recent confirmation.
 */
@Injectable()
export class DeletionFlowService {
  constructor(
    private readonly users: UsersService,
    private readonly pending: PendingStore,
    private readonly queue: UserDeletionQueue,
    private readonly audit: AuditService,
  ) {}

  /** Step 1: the user typed DELETE. Remember the question for 5 minutes and ask for confirmation. */
  async request(user: UserState, session: ReplySession): Promise<void> {
    await this.pending.set('delete', user.id);
    await this.audit.log({ actor: 'user', userId: user.id, action: 'delete_requested' });
    await session.buttons('delete.confirm_question', {}, DELETE_BUTTONS);
  }

  /** Step 2a: "No" (or any later cancel). Never deletes anything. */
  async cancel(user: UserState, session: ReplySession): Promise<void> {
    await this.pending.clear('delete', user.id);
    await session.text('delete.cancelled');
  }

  /**
   * Step 2b: "Yes, delete everything". Valid only while the pending key exists (5 minutes);
   * otherwise the user hears that it expired and nothing happens.
   *
   * Order is chosen so that a retried job repeats safely: enqueue the (idempotent) erasure job and
   * mark the user BEFORE the pending key is removed.
   */
  async confirm(user: UserState, session: ReplySession): Promise<void> {
    if (!(await this.pending.exists('delete', user.id))) {
      await session.text('delete.expired');
      return;
    }
    const waPhoneEnc = await this.users.getEncryptedPhone(user.id);
    await this.queue.add({
      userId: user.id,
      waPhoneEnc,
      language: session.currentLanguage,
      requestId: session.requestId,
    });
    // From now on the router ignores this user while the job erases the data.
    await this.users.markDeletionPending(user.id);
    await this.pending.clear('delete', user.id);
    // No reply here: the final "all deleted" message is sent by the job once the data is gone.
  }
}
