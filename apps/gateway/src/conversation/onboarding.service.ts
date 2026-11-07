import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import type { InboundJobData } from '../queues/queue.constants';
import { type UserLanguage, type UserState, UsersService } from '../users/users.service';
import { BUTTON_ID, type CommandName } from './commands';
import type { ButtonSpec, ReplySession } from './replies.service';

/** Version of the consent text (`consent.v1.*` in the i18n files). Bump it when the text changes. */
export const CONSENT_VERSION = 'v1';

export const LANGUAGE_BUTTONS: readonly ButtonSpec[] = [
  { id: BUTTON_ID.langHi, titleKey: 'buttons.lang_hi' },
  { id: BUTTON_ID.langEn, titleKey: 'buttons.lang_en' },
];

export const CONSENT_BUTTONS: readonly ButtonSpec[] = [
  { id: BUTTON_ID.consentYes, titleKey: 'buttons.consent_yes' },
  { id: BUTTON_ID.consentNo, titleKey: 'buttons.consent_no' },
];

export type OnboardingStepInProgress = 'language' | 'consent';

export type OnboardingInput =
  { kind: 'button'; id: string } | { kind: 'command'; command: CommandName } | { kind: 'other' };

export type OnboardingAction =
  | { type: 'ask_language' }
  | { type: 'choose_language'; language: UserLanguage }
  | { type: 'change_language_and_resend_consent'; language: UserLanguage }
  | { type: 'accept_consent' }
  | { type: 'decline_consent' }
  | { type: 'remind_consent' };

function languageOfButton(id: string): UserLanguage | null {
  if (id === BUTTON_ID.langHi) return 'hi';
  if (id === BUTTON_ID.langEn) return 'en';
  return null;
}

/**
 * The whole onboarding state machine as ONE pure function (step x input -> action), so every
 * transition is visible in one place and testable as a table (CLAUDE.md §7.1):
 *
 *   language --(lang:hi | lang:en)--> consent --(consent:yes)--> done
 *
 * Anything that is not the expected answer re-asks the current question. Nothing the user sends
 * (a photo, a document, "hello") is ever processed while a step is open.
 */
export function decideOnboarding(
  step: OnboardingStepInProgress,
  input: OnboardingInput,
): OnboardingAction {
  const language = input.kind === 'button' ? languageOfButton(input.id) : null;

  if (step === 'language') {
    return language ? { type: 'choose_language', language } : { type: 'ask_language' };
  }

  // step === 'consent'
  if (input.kind === 'button') {
    if (input.id === BUTTON_ID.consentYes) return { type: 'accept_consent' };
    if (input.id === BUTTON_ID.consentNo) return { type: 'decline_consent' };
    if (language) return { type: 'change_language_and_resend_consent', language };
  }
  if (input.kind === 'command' && input.command === 'language') {
    return { type: 'ask_language' };
  }
  return { type: 'remind_consent' };
}

function inputOf(job: InboundJobData): OnboardingInput {
  if (job.button) return { kind: 'button', id: job.button.id };
  if (job.signals?.command) return { kind: 'command', command: job.signals.command };
  return { kind: 'other' };
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** Handle a message from a user whose onboarding is not finished. */
  async handle(user: UserState, job: InboundJobData, session: ReplySession): Promise<void> {
    if (user.onboardingStep === 'done') {
      return;
    }
    const action = decideOnboarding(user.onboardingStep, inputOf(job));

    switch (action.type) {
      case 'ask_language':
        await session.buttons('onboarding.choose_language', {}, LANGUAGE_BUTTONS);
        return;

      case 'choose_language': {
        const moved = await this.users.chooseLanguage(user.id, action.language);
        session.useLanguage(action.language);
        if (moved) {
          await this.audit.log({
            actor: 'user',
            userId: user.id,
            action: 'language_changed',
            metadata: { language: action.language },
          });
        }
        await this.sendConsent(session);
        return;
      }

      case 'change_language_and_resend_consent':
        await this.users.setLanguage(user.id, action.language);
        session.useLanguage(action.language);
        if (user.language !== action.language) {
          await this.audit.log({
            actor: 'user',
            userId: user.id,
            action: 'language_changed',
            metadata: { language: action.language },
          });
        }
        await this.sendConsent(session);
        return;

      case 'accept_consent': {
        const moved = await this.users.acceptConsent(user.id, CONSENT_VERSION);
        if (moved) {
          await this.audit.log({
            actor: 'user',
            userId: user.id,
            action: 'consent_given',
            metadata: { version: CONSENT_VERSION },
          });
        }
        await session.text('consent.v1.accepted_welcome');
        return;
      }

      case 'decline_consent':
        await this.audit.log({
          actor: 'user',
          userId: user.id,
          action: 'consent_declined',
          metadata: { version: CONSENT_VERSION },
        });
        await session.text('consent.v1.declined');
        return;

      case 'remind_consent':
        // Includes photos and documents sent before consent: nothing is downloaded or read.
        await session.buttons('consent.v1.reminder', {}, CONSENT_BUTTONS);
        return;
    }
  }

  private sendConsent(session: ReplySession): Promise<void> {
    return session.buttons(
      'consent.v1.body',
      {
        retention_days: this.env.MEDIA_RETENTION_DAYS,
        privacy_url: this.env.PRIVACY_POLICY_URL,
      },
      CONSENT_BUTTONS,
    );
  }
}
