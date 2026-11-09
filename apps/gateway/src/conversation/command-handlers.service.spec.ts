import type { MedicationWarningsService } from '../medications/medication-warnings.service';
import type { ReminderScheduleService } from '../reminders/reminder-schedule.service';
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
  consentVersion: 'v2',
  voiceReplies: false,
  deletedAt: null,
};

function setup(options: { tts?: boolean } = {}): {
  handlers: CommandHandlersService;
  users: Record<
    | 'setLanguage'
    | 'setRemindersEnabled'
    | 'activeMedications'
    | 'setVoiceReplies'
    | 'acceptVoiceNotice',
    jest.Mock
  >;
  audit: { log: jest.Mock };
  schedules: Record<'suspendAll' | 'resumeAll' | 'todayStatus', jest.Mock>;
  warnings: { medicationIdsWithWarnings: jest.Mock };
  session: Record<'text' | 'buttons' | 'textLines' | 'useLanguage' | 'translate', jest.Mock>;
} {
  const users = {
    setLanguage: jest.fn().mockResolvedValue(undefined),
    setRemindersEnabled: jest.fn().mockResolvedValue(undefined),
    activeMedications: jest.fn().mockResolvedValue([]),
    setVoiceReplies: jest.fn().mockResolvedValue(undefined),
    acceptVoiceNotice: jest.fn().mockResolvedValue(true),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const schedules = {
    suspendAll: jest.fn().mockResolvedValue(0),
    resumeAll: jest.fn().mockResolvedValue(undefined),
    todayStatus: jest.fn().mockResolvedValue(new Map()),
  };
  const warnings = {
    medicationIdsWithWarnings: jest.fn().mockResolvedValue(new Set<string>()),
  };
  const session = {
    text: jest.fn().mockResolvedValue(undefined),
    buttons: jest.fn().mockResolvedValue(undefined),
    textLines: jest.fn().mockResolvedValue(undefined),
    useLanguage: jest.fn(),
    translate: jest
      .fn()
      .mockImplementation((key: string, params?: { count?: number }) =>
        params?.count !== undefined ? `${key}:${params.count}` : key,
      ),
  };
  return {
    handlers: new CommandHandlersService(
      users as unknown as UsersService,
      audit as unknown as AuditService,
      schedules as unknown as ReminderScheduleService,
      warnings as unknown as MedicationWarningsService,
      { TTS_ENABLED: options.tts ?? true },
    ),
    users,
    audit,
    schedules,
    warnings,
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

  describe('MEDS with warnings (M11)', () => {
    it('marks a medicine that is part of an active warning and uses the hint header', async () => {
      const s = setup();
      s.users.activeMedications.mockResolvedValue([
        { id: 'm1', name: 'Dolo 650', timings: [], frequencyPerDay: 2, asNeeded: false },
        { id: 'm2', name: 'Pantop', timings: [], frequencyPerDay: 1, asNeeded: false },
      ]);
      s.warnings.medicationIdsWithWarnings.mockResolvedValue(new Set(['m1']));
      await s.handlers.meds(user, asSession(s));
      expect(s.session.textLines).toHaveBeenCalledWith('meds.list_header_warn', [
        { key: 'meds.item', params: { name: '⚠️ Dolo 650', timings: 'meds.when_times:2' } },
        { key: 'meds.item', params: { name: 'Pantop', timings: 'meds.when_times:1' } },
      ]);
    });

    it('keeps the plain header when nothing is flagged', async () => {
      const s = setup();
      s.users.activeMedications.mockResolvedValue([
        { id: 'm1', name: 'Dolo 650', timings: ['08:00'], frequencyPerDay: 1, asNeeded: false },
      ]);
      await s.handlers.meds(user, asSession(s));
      expect(s.session.textLines.mock.calls[0]?.[0]).toBe('meds.list_header');
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
        { name: 'Dolo 650', timings: ['08:00', '20:00'], frequencyPerDay: 2, asNeeded: false },
        { name: 'Vitamin D', timings: [], frequencyPerDay: null, asNeeded: false },
        { name: 'Crocin', timings: [], frequencyPerDay: null, asNeeded: true },
        { name: 'Cough Syp', timings: [], frequencyPerDay: 3, asNeeded: false },
      ]);
      await s.handlers.meds(user, asSession(s));
      expect(s.session.textLines).toHaveBeenCalledWith('meds.list_header', [
        { key: 'meds.item', params: { name: 'Dolo 650', timings: '08:00, 20:00' } },
        { key: 'meds.item', params: { name: 'Vitamin D', timings: '–' } },
        { key: 'meds.item', params: { name: 'Crocin', timings: 'meds.when_as_needed' } },
        { key: 'meds.item', params: { name: 'Cough Syp', timings: 'meds.when_times:3' } },
      ]);
    });
  });
});

describe('CommandHandlersService: voice (M13)', () => {
  it('VOICE ON saves the preference, audits it and confirms', async () => {
    const s = setup();
    await s.handlers.setVoiceReplies(user, true, asSession(s));
    expect(s.users.setVoiceReplies).toHaveBeenCalledWith('user-1', true);
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'voice_replies_enabled' }),
    );
    expect(s.session.text).toHaveBeenCalledWith('voice.on');
  });

  it('VOICE ON is refused (and nothing saved) while the operator has TTS switched off', async () => {
    const s = setup({ tts: false });
    await s.handlers.setVoiceReplies(user, true, asSession(s));
    expect(s.users.setVoiceReplies).not.toHaveBeenCalled();
    expect(s.session.text).toHaveBeenCalledWith('voice.unavailable');
  });

  it('VOICE OFF always works', async () => {
    const s = setup({ tts: false });
    await s.handlers.setVoiceReplies({ ...user, voiceReplies: true }, false, asSession(s));
    expect(s.users.setVoiceReplies).toHaveBeenCalledWith('user-1', false);
    expect(s.session.text).toHaveBeenCalledWith('voice.off');
  });

  it('agreeing to the voice notice records consent v2, audits it, and asks for the note again', async () => {
    const s = setup();
    await s.handlers.answerVoiceNotice({ ...user, consentVersion: 'v1' }, true, asSession(s));
    expect(s.users.acceptVoiceNotice).toHaveBeenCalledWith('user-1', 'v2');
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'consent_updated',
        metadata: { version: 'v2', reason: 'voice' },
      }),
    );
    expect(s.session.text).toHaveBeenCalledWith('voice.notice_ok');
  });

  it('a double tap does not audit twice', async () => {
    const s = setup();
    s.users.acceptVoiceNotice.mockResolvedValue(false);
    await s.handlers.answerVoiceNotice(user, true, asSession(s));
    expect(s.audit.log).not.toHaveBeenCalled();
  });

  it('declining changes nothing', async () => {
    const s = setup();
    await s.handlers.answerVoiceNotice({ ...user, consentVersion: 'v1' }, false, asSession(s));
    expect(s.users.acceptVoiceNotice).not.toHaveBeenCalled();
    expect(s.session.text).toHaveBeenCalledWith('voice.notice_no');
  });
});
