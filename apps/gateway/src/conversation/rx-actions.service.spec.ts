import type { AiClient } from '../ai-client/ai-client';
import type { AuditService } from '../audit/audit.service';
import type { PrescriptionService } from '../documents/prescription.service';
import type { ReminderScheduleService } from '../reminders/reminder-schedule.service';
import type { UserState } from '../users/users.service';
import type { ReminderFlowService } from './reminder-flow.service';
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

const ITEMS = [
  {
    name: 'Dolo 650',
    strength: '650 mg',
    generic: { alternatives: [{ drug_id: 'd1', brand_name: 'Paracetamol IP' }] },
  },
];

function setup(
  markWrong: number | null = 2,
  items: unknown = ITEMS,
): {
  service: RxActionsService;
  prescriptions: { markWrong: jest.Mock; genericItems: jest.Mock };
  audit: { log: jest.Mock };
  ai: { genericDetails: jest.Mock };
  reminderFlow: { start: jest.Mock };
  schedules: { cancelForDocument: jest.Mock };
  session: { text: jest.Mock; textAt: jest.Mock; rawText: jest.Mock; requestId: string };
} {
  const prescriptions = {
    markWrong: jest.fn().mockResolvedValue(markWrong),
    genericItems: jest.fn().mockResolvedValue(items),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const ai = {
    genericDetails: jest.fn().mockResolvedValue({ request_id: 'r', reply: { text: 'DETAILS' } }),
  };
  const reminderFlow = { start: jest.fn().mockResolvedValue('rem_preview') };
  const schedules = { cancelForDocument: jest.fn().mockResolvedValue(3) };
  const session = {
    text: jest.fn().mockResolvedValue(undefined),
    textAt: jest.fn().mockResolvedValue(undefined),
    rawText: jest.fn().mockResolvedValue(undefined),
    requestId: 'req-1',
  };
  return {
    service: new RxActionsService(
      prescriptions as unknown as PrescriptionService,
      audit as unknown as AuditService,
      ai as unknown as AiClient,
      reminderFlow as unknown as ReminderFlowService,
      schedules as unknown as ReminderScheduleService,
    ),
    reminderFlow,
    schedules,
    prescriptions,
    audit,
    ai,
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

  it('reminders starts the reminder flow and touches nothing else', async () => {
    const s = setup();
    const outcome = await s.service.handle(
      user,
      { action: 'reminders', documentId: DOC },
      s.session as unknown as ReplySession,
    );
    expect(outcome).toBe('rx_reminders');
    expect(s.reminderFlow.start).toHaveBeenCalledWith(user, DOC, s.session);
    expect(s.prescriptions.markWrong).not.toHaveBeenCalled();
  });

  describe('generic details (M8)', () => {
    const tap = (s: ReturnType<typeof setup>) =>
      s.service.handle(
        user,
        { action: 'generic', documentId: DOC },
        s.session as unknown as ReplySession,
      );

    it('sends the stored suggestions to the AI service in the user language and relays its text', async () => {
      const s = setup();
      await expect(tap(s)).resolves.toBe('rx_generic_details');
      expect(s.prescriptions.genericItems).toHaveBeenCalledWith('user-1', DOC);
      expect(s.ai.genericDetails).toHaveBeenCalledWith({
        request_id: 'req-1-generic',
        language: 'en',
        medicines: ITEMS,
      });
      expect(s.session.rawText).toHaveBeenCalledWith('DETAILS');
    });

    it('a foreign or unknown document gets the neutral answer and no AI call', async () => {
      const s = setup(2, null);
      await expect(tap(s)).resolves.toBe('rx_not_found');
      expect(s.session.text).toHaveBeenCalledWith('rx.not_found');
      expect(s.ai.genericDetails).not.toHaveBeenCalled();
    });

    it.each([[[]], [[{ name: 'Dolo', strength: null, generic: null }]]])(
      'a prescription without stored suggestions says so instead of an empty list (%j)',
      async (items) => {
        const s = setup(2, items);
        await expect(tap(s)).resolves.toBe('rx_generic_unavailable');
        expect(s.session.text).toHaveBeenCalledWith('rx.generic_unavailable');
        expect(s.ai.genericDetails).not.toHaveBeenCalled();
      },
    );

    it('an AI failure sends ONE error message at the fixed index and rethrows for the retry', async () => {
      const s = setup();
      s.ai.genericDetails.mockRejectedValue(new Error('down'));
      await expect(tap(s)).rejects.toThrow('down');
      expect(s.session.textAt).toHaveBeenCalledWith(99, 'common.error_try_again');
      expect(s.session.rawText).not.toHaveBeenCalled();
    });
  });
});
