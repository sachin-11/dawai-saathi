import type { AuditService } from '../audit/audit.service';
import type { PendingStore } from '../common/pending/pending.store';
import type { UserDeletionQueue } from '../deletion/user-deletion.queue';
import type { UserState, UsersService } from '../users/users.service';
import { DeletionFlowService } from './deletion-flow.service';
import type { ReplySession } from './replies.service';

const user: UserState = {
  id: 'user-1',
  language: 'en',
  onboardingStep: 'done',
  consentAt: new Date(),
  remindersEnabled: true,
  consentVersion: 'v2',
  voiceReplies: false,
  deletedAt: null,
};

function setup(pendingExists = true): {
  service: DeletionFlowService;
  calls: string[];
  pending: Record<'set' | 'exists' | 'clear', jest.Mock>;
  queue: { add: jest.Mock };
  users: Record<'getEncryptedPhone' | 'markDeletionPending', jest.Mock>;
  audit: { log: jest.Mock };
  session: Record<'text' | 'buttons', jest.Mock> & { currentLanguage: string; requestId: string };
} {
  const calls: string[] = [];
  const track = (name: string, value?: unknown): jest.Mock =>
    jest.fn().mockImplementation(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  const pending = {
    set: track('pending.set'),
    exists: track('pending.exists', pendingExists),
    clear: track('pending.clear'),
  };
  const queue = { add: track('queue.add') };
  const users = {
    getEncryptedPhone: track('users.getEncryptedPhone', 'v1:enc:phone:data'),
    markDeletionPending: track('users.markDeletionPending'),
  };
  const audit = { log: track('audit.log') };
  const session = {
    text: track('session.text'),
    buttons: track('session.buttons'),
    currentLanguage: 'en',
    requestId: 'req-1',
  };
  const service = new DeletionFlowService(
    users as unknown as UsersService,
    pending as unknown as PendingStore,
    queue as unknown as UserDeletionQueue,
    audit as unknown as AuditService,
  );
  return { service, calls, pending, queue, users, audit, session };
}

describe('DeletionFlowService', () => {
  describe('step 1: DELETE', () => {
    it('asks for confirmation with two buttons and remembers the question for 5 minutes', async () => {
      const s = setup();
      await s.service.request(user, s.session as unknown as ReplySession);

      expect(s.pending.set).toHaveBeenCalledWith('delete', 'user-1');
      expect(s.audit.log).toHaveBeenCalledWith({
        actor: 'user',
        userId: 'user-1',
        action: 'delete_requested',
      });
      expect(s.session.buttons).toHaveBeenCalledWith('delete.confirm_question', {}, [
        { id: 'delete:confirm', titleKey: 'buttons.delete_yes' },
        { id: 'delete:cancel', titleKey: 'buttons.delete_no' },
      ]);
      expect(s.queue.add).not.toHaveBeenCalled(); // nothing is deleted yet
    });
  });

  describe('step 2a: cancel', () => {
    it('says nothing was deleted and clears the pending question', async () => {
      const s = setup();
      await s.service.cancel(user, s.session as unknown as ReplySession);
      expect(s.pending.clear).toHaveBeenCalledWith('delete', 'user-1');
      expect(s.session.text).toHaveBeenCalledWith('delete.cancelled');
      expect(s.queue.add).not.toHaveBeenCalled();
    });
  });

  describe('step 2b: confirm', () => {
    it('with a valid pending question: enqueues the erasure job (encrypted phone), marks the user, clears the key', async () => {
      const s = setup(true);
      await s.service.confirm(user, s.session as unknown as ReplySession);

      expect(s.queue.add).toHaveBeenCalledWith({
        userId: 'user-1',
        waPhoneEnc: 'v1:enc:phone:data',
        language: 'en',
        requestId: 'req-1',
      });
      expect(s.users.markDeletionPending).toHaveBeenCalledWith('user-1');
      expect(s.pending.clear).toHaveBeenCalledWith('delete', 'user-1');
      // no reply now: the erasure job sends the final message once the data is gone
      expect(s.session.text).not.toHaveBeenCalled();
    });

    it('is retry-safe: the job is enqueued and the user marked BEFORE the pending key is removed', async () => {
      const s = setup(true);
      await s.service.confirm(user, s.session as unknown as ReplySession);
      expect(s.calls.indexOf('queue.add')).toBeLessThan(s.calls.indexOf('pending.clear'));
      expect(s.calls.indexOf('users.markDeletionPending')).toBeLessThan(
        s.calls.indexOf('pending.clear'),
      );
    });

    it('after the 5-minute window (no pending key): says it expired and deletes NOTHING', async () => {
      const s = setup(false);
      await s.service.confirm(user, s.session as unknown as ReplySession);
      expect(s.session.text).toHaveBeenCalledWith('delete.expired');
      expect(s.queue.add).not.toHaveBeenCalled();
      expect(s.users.markDeletionPending).not.toHaveBeenCalled();
    });
  });
});
