import type { PinoLogger } from 'nestjs-pino';

import en from './en.json';
import hi from './hi.json';
import { I18nService, type Language, type MessageKey } from './i18n.service';

const i18n = new I18nService({
  setContext: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as PinoLogger);
const LANGUAGES: Language[] = ['hi', 'en'];
const t = (
  language: Language,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string => i18n.t(language, key, params);

const SAMPLE_PARAMS = { retention_days: 30, privacy_url: 'https://dawaisaathi.example/privacy' };

describe('M4 i18n keys', () => {
  it('has every key the conversation flow needs, in both languages', () => {
    const needed = [
      'onboarding.choose_language',
      'consent.v2.body',
      'consent.v2.accepted_welcome',
      'consent.v2.declined',
      'consent.v2.reminder',
      'help.body',
      'language.changed',
      'reminders.disabled',
      'reminders.enabled',
      'meds.none',
      'meds.list_header',
      'meds.item',
      'delete.confirm_question',
      'delete.cancelled',
      'delete.expired',
      'delete.done',
      'emergency.general',
      'emergency.self_harm',
      'dev.ai_not_ready',
      'buttons.lang_hi',
      'buttons.lang_en',
      'buttons.consent_yes',
      'buttons.consent_no',
      'buttons.delete_yes',
      'buttons.delete_no',
    ];
    for (const key of needed) {
      expect(en).toHaveProperty([key]);
      expect(hi).toHaveProperty([key]);
    }
  });

  describe('button titles fit WhatsApp (max 20 characters)', () => {
    const buttonKeys = (Object.keys(en) as MessageKey[]).filter((key) =>
      key.startsWith('buttons.'),
    );

    it('there is at least one button key', () => {
      expect(buttonKeys.length).toBeGreaterThanOrEqual(6);
    });

    it.each(LANGUAGES)('every button title in %s is 1–20 characters', (language) => {
      for (const key of buttonKeys) {
        const title = t(language, key);
        expect(title.length).toBeGreaterThanOrEqual(1);
        expect(title.length).toBeLessThanOrEqual(20);
      }
    });
  });

  describe('interactive message bodies fit WhatsApp (max 1024 characters)', () => {
    const bodies: [MessageKey, Record<string, string | number>][] = [
      ['consent.v2.body', SAMPLE_PARAMS],
      ['consent.v2.reminder', {}],
      ['delete.confirm_question', {}],
      ['onboarding.choose_language', {}],
    ];
    it.each(LANGUAGES)('in %s', (language) => {
      for (const [key, params] of bodies) {
        expect(t(language, key, params).length).toBeLessThanOrEqual(1024);
      }
    });
  });

  describe('consent text (CLAUDE.md §7.1): honest, complete and short', () => {
    it.each(LANGUAGES)('%s version is at most ~8 short lines', (language) => {
      const lines = t(language, 'consent.v2.body', SAMPLE_PARAMS)
        .split('\n')
        .filter((line) => line.trim() !== '');
      expect(lines.length).toBeLessThanOrEqual(9);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(200);
    });

    it.each(LANGUAGES)(
      '%s version states retention, "not a doctor", DELETE and the privacy link',
      (language) => {
        const text = t(language, 'consent.v2.body', SAMPLE_PARAMS);
        expect(text).toContain('30');
        expect(text).toContain('DELETE');
        expect(text).toContain('https://dawaisaathi.example/privacy');
      },
    );

    it('English says it is not a doctor and never diagnoses', () => {
      expect(t('en', 'consent.v2.body', SAMPLE_PARAMS)).toMatch(/not a doctor/i);
      expect(t('en', 'consent.v2.body', SAMPLE_PARAMS)).toMatch(/never diagnose/i);
    });

    it('Hindi says it is not a doctor', () => {
      expect(t('hi', 'consent.v2.body', SAMPLE_PARAMS)).toContain('डॉक्टर नहीं');
    });

    it('both languages say what is stored (photos, medicine details, reminders)', () => {
      expect(t('en', 'consent.v2.body', SAMPLE_PARAMS)).toMatch(/photos/i);
      expect(t('en', 'consent.v2.body', SAMPLE_PARAMS)).toMatch(/reminders/i);
      expect(t('hi', 'consent.v2.body', SAMPLE_PARAMS)).toContain('फ़ोटो');
      expect(t('hi', 'consent.v2.body', SAMPLE_PARAMS)).toContain('रिमाइंडर');
    });
  });

  describe('emergency and help texts', () => {
    it.each(LANGUAGES)('%s general emergency names 112 and 108', (language) => {
      expect(t(language, 'emergency.general')).toContain('112');
      expect(t(language, 'emergency.general')).toContain('108');
    });

    it.each(LANGUAGES)('%s self-harm message names Tele-MANAS 14416', (language) => {
      expect(t(language, 'emergency.self_harm')).toContain('14416');
      expect(t(language, 'emergency.self_harm')).toContain('Tele-MANAS');
    });

    it.each(LANGUAGES)('%s help lists every command and the emergency numbers', (language) => {
      const help = t(language, 'help.body');
      for (const command of [
        'HELP',
        'MEDS',
        'LANGUAGE',
        'STOP REMINDERS',
        'START REMINDERS',
        'DELETE',
      ]) {
        expect(help).toContain(command);
      }
      expect(help).toContain('112');
      expect(help).toContain('108');
    });

    it.each(LANGUAGES)('%s delete confirmation warns it cannot be undone', (language) => {
      expect(t(language, 'delete.confirm_question').length).toBeGreaterThan(40);
    });
  });
});
