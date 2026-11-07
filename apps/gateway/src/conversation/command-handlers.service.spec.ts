import type { AuditService } from '../audit/audit.service';
import type { UserState, UsersService } from '../users/users.service';
import { CommandHandlersService } from './command-handlers.service';
import { LANGUAGE_BUTTONS } from './onboarding.service';
import type { ReplySession } from './replies.service';

const user: UserState = {
  id: 'user-1',
  language: 'hi',
  onboardingStep: 'done',
  consentAt: new Date(),
  remindersEnabled: true,
  deletedAt: null,
};

function setup(): {
  handlers: CommandHandlersService;
  users: Record<'setLanguage' | 'setRemindersEnabled' | 'activeMedications', jest.Mock>;
  audit: { log: jest.Mock };
  session: Record<'text' | 'buttons' | 'textLines' | 'useLanguage', jest.Mock>;
} {
  const users = {
    setLanguage: jest.fn().mockResolvedValue(undefined),
    setRemindersEnabled: jest.fn().mockResolvedValue(undefined),
    activeMedications: jest.fn().mockResolvedValue([]),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const session = {
    text: jest.fn().mockResolvedValue(undefined),
    buttons: jest.fn().mockResolvedValue(undefined),
    textLines: jest.fn().mockResolvedValue(undefined),
    useLanguage: jest.fn(),
  };
  return {
    handlers: new CommandHandlersService(
      users as unknown as UsersService,
      audit as unknown as AuditService,
    ),
    users,
    audit,
    session,
  };
}
const asSession = (s: ReturnType<typeof setup>): ReplySession =>
  s.session as unknown as ReplySession;

describe('CommandHandlersService', () => {
  it('HELP sends the help text', async () => {
    const s = setup();
    await s.handlers.help(asSession(s));
    expect(s.session.text).toHaveBeenCalledWith('help.body');
  });

  it('LANGUAGE shows the language buttons', async () => {
    const s = setup();
    await s.handlers.askLanguage(asSession(s));
    expect(s.session.buttons).toHaveBeenCalledWith(
      'onboarding.choose_language',
      {},
      LANGUAGE_BUTTONS,
    );
  });

  describe('language change', () => {
    it('saves, audits and confirms IN the new language', async () => {
      const s = setup();
      await s.handlers.setLanguage(user, 'en', asSession(s));
      expect(s.users.setLanguage).toHaveBeenCalledWith('user-1', 'en');
      expect(s.session.useLanguage).toHaveBeenCalledWith('en');
      expect(s.session.useLanguage.mock.invocationCallOrder[0]).toBeLessThan(
        s.session.text.mock.invocationCallOrder[0] ?? 0,
      );
      expect(s.audit.log).toHaveBeenCalledWith({
        actor: 'user',
        userId: 'user-1',
        action: 'language_changed',
        metadata: { language: 'en' },
      });
      expect(s.session.text).toHaveBeenCalledWith('language.changed');
    });

    it('choosing the language the user already has is confirmed but not audited again', async () => {
      const s = setup();
      await s.handlers.setLanguage(user, 'hi', asSession(s));
      expect(s.audit.log).not.toHaveBeenCalled();
      expect(s.session.text).toHaveBeenCalledWith('language.changed');
    });
  });

  describe('reminders', () => {
    it('STOP REMINDERS switches them off, audits and confirms', async () => {
      const s = setup();
      await s.handlers.setReminders(user, false, asSession(s));
      expect(s.users.setRemindersEnabled).toHaveBeenCalledWith('user-1', false);
      expect(s.audit.log).toHaveBeenCalledWith({
        actor: 'user',
        userId: 'user-1',
        action: 'reminders_disabled',
      });
      expect(s.session.text).toHaveBeenCalledWith('reminders.disabled');
    });

    it('START REMINDERS switches them on again', async () => {
      const s = setup();
      await s.handlers.setReminders({ ...user, remindersEnabled: false }, true, asSession(s));
      expect(s.users.setRemindersEnabled).toHaveBeenCalledWith('user-1', true);
      expect(s.audit.log).toHaveBeenCalledWith({
        actor: 'user',
        userId: 'user-1',
        action: 'reminders_enabled',
      });
      expect(s.session.text).toHaveBeenCalledWith('reminders.enabled');
    });

    it('repeating STOP when already stopped confirms without a second audit row', async () => {
      const s = setup();
      await s.handlers.setReminders({ ...user, remindersEnabled: false }, false, asSession(s));
      expect(s.audit.log).not.toHaveBeenCalled();
      expect(s.session.text).toHaveBeenCalledWith('reminders.disabled');
    });
  });

  describe('MEDS', () => {
    it('says there are none when the user has no active medicine', async () => {
      const s = setup();
      await s.handlers.meds(user, asSession(s));
      expect(s.session.text).toHaveBeenCalledWith('meds.none');
      expect(s.session.textLines).not.toHaveBeenCalled();
    });

    it('lists name and timings as one message', async () => {
      const s = setup();
      s.users.activeMedications.mockResolvedValue([
        { name: 'Dolo 650', timings: ['08:00', '20:00'] },
        { name: 'Vitamin D', timings: [] },
      ]);
      await s.handlers.meds(user, asSession(s));
      expect(s.session.textLines).toHaveBeenCalledWith('meds.list_header', [
        { key: 'meds.item', params: { name: 'Dolo 650', timings: '08:00, 20:00' } },
        { key: 'meds.item', params: { name: 'Vitamin D', timings: '–' } },
      ]);
    });
  });
});
