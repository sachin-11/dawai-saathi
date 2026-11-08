import type { AuditService } from '../audit/audit.service';
import type { PrescriptionService } from '../documents/prescription.service';
import type { UserState } from '../users/users.service';
import type { ReplySession } from './replies.service';
import { parseRxButton, RxActionsService } from './rx-actions.service';

const user: UserState = {
  id: 'user-1',
  language: 'en',
  onboardingStep: 'done',
  consentAt: new Date(),
  remindersEnabled: true,
  deletedAt: null,
};
const DOC = '3f2b8c1e-5d0a-4b7e-9c61-0a1b2c3d4e5f';

function setup(markWrong: number | null = 2): {
  service: RxActionsService;
  prescriptions: { markWrong: jest.Mock };
  audit: { log: jest.Mock };
  session: { text: jest.Mock };
} {
  const prescriptions = { markWrong: jest.fn().mockResolvedValue(markWrong) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const session = { text: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new RxActionsService(
      prescriptions as unknown as PrescriptionService,
      audit as unknown as AuditService,
    ),
    prescriptions,
    audit,
    session,
  };
}

describe('parseRxButton', () => {
  it.each([
    [`rx:wrong:${DOC}`, { action: 'wrong', documentId: DOC }],
    [`rx:reminders:${DOC}`, { action: 'reminders', documentId: DOC }],
    [`rx:generic:${DOC}`, { action: 'generic', documentId: DOC }],
  ])('parses %s', (id, expected) => {
    expect(parseRxButton(id)).toEqual(expected);
  });

  it.each([
    'lang:hi',
    'rx:wrong',
    'rx:wrong:',
    'rx:delete:abc',
    'rx:wrong:a b',
    'xrx:wrong:abc',
    '',
  ])('rejects %p', (id) => {
    expect(parseRxButton(id)).toBeNull();
  });
});

describe('RxActionsService', () => {
  it('"Something is wrong" deactivates the medicines, audits counts only and tells the user', async () => {
    const s = setup(2);
    const outcome = await s.service.handle(
      user,
      { action: 'wrong', documentId: DOC },
      s.session as unknown as ReplySession,
    );
    expect(outcome).toBe('rx_wrong');
    expect(s.prescriptions.markWrong).toHaveBeenCalledWith('user-1', DOC);
    expect(s.audit.log).toHaveBeenCalledWith({
      actor: 'user',
      userId: 'user-1',
      action: 'rx_reported_wrong',
      metadata: { medications_deactivated: 2 },
    });
    expect(s.session.text).toHaveBeenCalledWith('rx.wrong_ack');
  });

  it('an unknown or foreign document gets a neutral message and no audit entry', async () => {
    const s = setup(null);
    const outcome = await s.service.handle(
      user,
      { action: 'wrong', documentId: DOC },
      s.session as unknown as ReplySession,
    );
    expect(outcome).toBe('rx_not_found');
    expect(s.audit.log).not.toHaveBeenCalled();
    expect(s.session.text).toHaveBeenCalledWith('rx.not_found');
  });

  it.each([
    ['reminders', 'rx.reminders_soon'],
    ['generic', 'rx.generic_soon'],
  ] as const)('%s says "coming soon" and touches nothing', async (action, key) => {
    const s = setup();
    const outcome = await s.service.handle(
      user,
      { action, documentId: DOC },
      s.session as unknown as ReplySession,
    );
    expect(outcome).toBe('rx_coming_soon');
    expect(s.session.text).toHaveBeenCalledWith(key);
    expect(s.prescriptions.markWrong).not.toHaveBeenCalled();
  });
});
