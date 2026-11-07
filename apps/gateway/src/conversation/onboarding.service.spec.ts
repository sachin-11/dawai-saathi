import type { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env.schema';
import type { InboundJobData } from '../queues/queue.constants';
import type { UserState, UsersService } from '../users/users.service';
import { BUTTON_ID } from './commands';
import {
  CONSENT_BUTTONS,
  CONSENT_VERSION,
  LANGUAGE_BUTTONS,
  OnboardingService,
  type OnboardingAction,
  type OnboardingInput,
  type OnboardingStepInProgress,
  decideOnboarding,
} from './onboarding.service';
import type { ReplySession } from './replies.service';

const button = (id: string): OnboardingInput => ({ kind: 'button', id });
const OTHER: OnboardingInput = { kind: 'other' };

describe('decideOnboarding (step x input -> action)', () => {
  const table: [OnboardingStepInProgress, string, OnboardingInput, OnboardingAction][] = [
    [
      'language',
      'lang:hi button',
      button(BUTTON_ID.langHi),
      { type: 'choose_language', language: 'hi' },
    ],
    [
      'language',
      'lang:en button',
      button(BUTTON_ID.langEn),
      { type: 'choose_language', language: 'en' },
    ],
    ['language', 'a text message', OTHER, { type: 'ask_language' }],
    ['language', 'a photo (also "other")', OTHER, { type: 'ask_language' }],
    ['language', 'a stale consent button', button(BUTTON_ID.consentYes), { type: 'ask_language' }],
    ['language', 'an unknown button', button('whatever'), { type: 'ask_language' }],
    [
      'language',
      'the LANGUAGE command',
      { kind: 'command', command: 'language' },
      { type: 'ask_language' },
    ],
    ['consent', 'consent:yes', button(BUTTON_ID.consentYes), { type: 'accept_consent' }],
    ['consent', 'consent:no', button(BUTTON_ID.consentNo), { type: 'decline_consent' }],
    [
      'consent',
      'lang:en (changing language while consenting)',
      button(BUTTON_ID.langEn),
      { type: 'change_language_and_resend_consent', language: 'en' },
    ],
    [
      'consent',
      'the LANGUAGE command',
      { kind: 'command', command: 'language' },
      { type: 'ask_language' },
    ],
    ['consent', 'a text message', OTHER, { type: 'remind_consent' }],
    ['consent', 'a photo before consent', OTHER, { type: 'remind_consent' }],
    ['consent', 'MEDS command', { kind: 'command', command: 'meds' }, { type: 'remind_consent' }],
    ['consent', 'an unknown button', button('delete:oops'), { type: 'remind_consent' }],
  ];

  it.each(table)('step %s + %s -> %j', (step, _name, input, expected) => {
    expect(decideOnboarding(step, input)).toEqual(expected);
  });
});

const env = {
  MEDIA_RETENTION_DAYS: 30,
  PRIVACY_POLICY_URL: 'https://dawaisaathi.example/privacy',
} as Env;

function setup(user: Partial<UserState>): {
  service: OnboardingService;
  state: UserState;
  users: Record<'chooseLanguage' | 'setLanguage' | 'acceptConsent', jest.Mock>;
  audit: { log: jest.Mock };
  session: Record<'text' | 'buttons' | 'useLanguage', jest.Mock>;
} {
  const state: UserState = {
    id: 'user-1',
    language: 'hi',
    onboardingStep: 'language',
    consentAt: null,
    remindersEnabled: true,
    deletedAt: null,
    ...user,
  };
  const users = {
    chooseLanguage: jest.fn().mockResolvedValue(true),
    setLanguage: jest.fn().mockResolvedValue(undefined),
    acceptConsent: jest.fn().mockResolvedValue(true),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const session = {
    text: jest.fn().mockResolvedValue(undefined),
    buttons: jest.fn().mockResolvedValue(undefined),
    useLanguage: jest.fn(),
  };
  const service = new OnboardingService(
    env,
    users as unknown as UsersService,
    audit as unknown as AuditService,
  );
  return { service, state, users, audit, session };
}

const job = (overrides: Partial<InboundJobData>): InboundJobData => ({
  messageId: 'msg-1',
  userId: 'user-1',
  waMessageId: 'wamid.1',
  type: 'text',
  receivedAt: new Date().toISOString(),
  requestId: 'req-1',
  ...overrides,
});
const tap = (id: string): InboundJobData =>
  job({ type: 'button', button: { id, title: 'ignored' } });

describe('OnboardingService.handle', () => {
  const run = (s: ReturnType<typeof setup>, j: InboundJobData): Promise<void> =>
    s.service.handle(s.state, j, s.session as unknown as ReplySession);

  describe('step: language', () => {
    it('any first message gets the language buttons (nothing is saved, nothing processed)', async () => {
      const s = setup({ onboardingStep: 'language' });
      await run(s, job({ type: 'image', media: { id: 'm1', mimeType: 'image/jpeg' } }));
      expect(s.session.buttons).toHaveBeenCalledWith(
        'onboarding.choose_language',
        {},
        LANGUAGE_BUTTONS,
      );
      expect(s.users.chooseLanguage).not.toHaveBeenCalled();
      expect(s.audit.log).not.toHaveBeenCalled();
    });

    it('a language button saves the language, audits it and sends the consent message in that language', async () => {
      const s = setup({ onboardingStep: 'language' });
      await run(s, tap(BUTTON_ID.langEn));
      expect(s.users.chooseLanguage).toHaveBeenCalledWith('user-1', 'en');
      expect(s.session.useLanguage).toHaveBeenCalledWith('en');
      expect(s.audit.log).toHaveBeenCalledWith({
        actor: 'user',
        userId: 'user-1',
        action: 'language_changed',
        metadata: { language: 'en' },
      });
      expect(s.session.buttons).toHaveBeenCalledWith(
        'consent.v1.body',
        { retention_days: 30, privacy_url: 'https://dawaisaathi.example/privacy' },
        CONSENT_BUTTONS,
      );
    });

    it('a retried tap does not audit twice but still (idempotently) sends the consent message', async () => {
      const s = setup({ onboardingStep: 'language' });
      s.users.chooseLanguage.mockResolvedValue(false);
      await run(s, tap(BUTTON_ID.langHi));
      expect(s.audit.log).not.toHaveBeenCalled();
      expect(s.session.buttons).toHaveBeenCalledWith(
        'consent.v1.body',
        expect.anything(),
        CONSENT_BUTTONS,
      );
    });
  });

  describe('step: consent', () => {
    it('"I agree" records consent v1, audits it and sends the welcome', async () => {
      const s = setup({ onboardingStep: 'consent' });
      await run(s, tap(BUTTON_ID.consentYes));
      expect(s.users.acceptConsent).toHaveBeenCalledWith('user-1', CONSENT_VERSION);
      expect(CONSENT_VERSION).toBe('v1');
      expect(s.audit.log).toHaveBeenCalledWith({
        actor: 'user',
        userId: 'user-1',
        action: 'consent_given',
        metadata: { version: 'v1' },
      });
      expect(s.session.text).toHaveBeenCalledWith('consent.v1.accepted_welcome');
    });

    it('a repeated "I agree" does not audit twice but still sends the welcome', async () => {
      const s = setup({ onboardingStep: 'consent' });
      s.users.acceptConsent.mockResolvedValue(false);
      await run(s, tap(BUTTON_ID.consentYes));
      expect(s.audit.log).not.toHaveBeenCalled();
      expect(s.session.text).toHaveBeenCalledWith('consent.v1.accepted_welcome');
    });

    it('"Not now" audits the refusal, replies politely and does NOT move the user on', async () => {
      const s = setup({ onboardingStep: 'consent' });
      await run(s, tap(BUTTON_ID.consentNo));
      expect(s.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'consent_declined', metadata: { version: 'v1' } }),
      );
      expect(s.session.text).toHaveBeenCalledWith('consent.v1.declined');
      expect(s.users.acceptConsent).not.toHaveBeenCalled();
    });

    it.each([
      ['a photo', job({ type: 'image', media: { id: 'm1', mimeType: 'image/jpeg' } })],
      ['a PDF', job({ type: 'document', media: { id: 'm2', mimeType: 'application/pdf' } })],
      ['a voice note', job({ type: 'audio', media: { id: 'm3', mimeType: 'audio/ogg' } })],
      ['a text', job({ type: 'text' })],
    ])('%s before consent only brings the consent reminder', async (_name, j) => {
      const s = setup({ onboardingStep: 'consent' });
      await run(s, j);
      expect(s.session.buttons).toHaveBeenCalledTimes(1);
      expect(s.session.buttons).toHaveBeenCalledWith('consent.v1.reminder', {}, CONSENT_BUTTONS);
      expect(s.users.acceptConsent).not.toHaveBeenCalled();
      expect(s.audit.log).not.toHaveBeenCalled();
    });

    it('changing the language while consenting re-sends the consent in the new language', async () => {
      const s = setup({ onboardingStep: 'consent', language: 'hi' });
      await run(s, tap(BUTTON_ID.langEn));
      expect(s.users.setLanguage).toHaveBeenCalledWith('user-1', 'en');
      expect(s.session.useLanguage).toHaveBeenCalledWith('en');
      expect(s.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'language_changed', metadata: { language: 'en' } }),
      );
      expect(s.session.buttons).toHaveBeenCalledWith(
        'consent.v1.body',
        expect.anything(),
        CONSENT_BUTTONS,
      );
    });
  });

  it('does nothing for a user who has finished onboarding', async () => {
    const s = setup({ onboardingStep: 'done' });
    await run(s, job({}));
    expect(s.session.buttons).not.toHaveBeenCalled();
    expect(s.session.text).not.toHaveBeenCalled();
  });
});
