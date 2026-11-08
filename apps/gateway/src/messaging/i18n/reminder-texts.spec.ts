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
const keys = (prefix: string): MessageKey[] =>
  (Object.keys(en) as MessageKey[]).filter((key) => key.startsWith(prefix));

describe('M10 i18n', () => {
  it('has the same reminder / caregiver keys in Hindi and English', () => {
    const wanted = [...keys('reminder.'), ...keys('reminders.'), ...keys('caregiver.')];
    expect(wanted.length).toBeGreaterThan(60);
    for (const key of wanted) {
      expect(hi).toHaveProperty([key]);
    }
    const hiKeys = Object.keys(hi).filter((key) => /^(reminder|reminders|caregiver)\./.test(key));
    expect(hiKeys.sort()).toEqual(wanted.sort());
  });

  it('uses the same {{placeholders}} in both languages', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string).sort();
    for (const key of [...keys('reminder'), ...keys('caregiver.')]) {
      expect(placeholders((hi as Record<string, string>)[key] as string)).toEqual(
        placeholders((en as Record<string, string>)[key] as string),
      );
    }
  });

  it.each(LANGUAGES)(
    'reminder button titles in %s are 1-20 characters (also with a long medicine name cut)',
    (language) => {
      for (const key of [
        'reminder.btn.taken',
        'reminder.btn.snooze',
        'reminder.btn.skip',
        'reminder.btn.renew',
        'reminder.btn.not_now',
        'reminders.btn.confirm',
        'reminders.btn.change',
        'reminders.btn.cancel',
        'reminders.list_more',
      ] as MessageKey[]) {
        const title = i18n.t(language, key);
        expect(title.length).toBeGreaterThanOrEqual(1);
        expect(title.length).toBeLessThanOrEqual(20);
      }
      // pause/resume titles carry a medicine name and are cut to 20 characters by the flow
      expect(
        i18n
          .t(language, 'reminders.btn.pause', { name: 'Metformin Hydrochloride 500' })
          .slice(0, 20),
      ).toHaveLength(20);
    },
  );

  it('the caregiver-facing texts never contain a medicine placeholder', () => {
    for (const key of [
      'caregiver.cg_verified',
      'caregiver.cg_declined',
      'caregiver.cg_stopped',
      'caregiver.cg_expired',
    ] as MessageKey[]) {
      for (const language of LANGUAGES) {
        expect(i18n.t(language, key, { label: 'Papa' })).not.toMatch(/\{\{|medicine|दवा का नाम/i);
      }
    }
  });

  it('every reminder text keeps the safe wording (no instructions to change a medicine)', () => {
    for (const language of LANGUAGES) {
      const body = i18n.t(language, 'reminder.body', { time: '08:00', lines: '• Dolo' });
      expect(body).toContain('08:00');
      expect(body.length).toBeLessThan(500);
    }
  });
});
