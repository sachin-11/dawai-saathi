import type { PinoLogger } from 'nestjs-pino';

import en from './en.json';
import hi from './hi.json';
import { I18nService, type MessageKey } from './i18n.service';

const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() };
const make = (): I18nService => new I18nService(logger as unknown as PinoLogger);

beforeEach(() => {
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe('i18n dictionaries', () => {
  it('hi.json and en.json have exactly the same keys', () => {
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
  });

  it('contains every key M3 needs', () => {
    for (const key of [
      'common.received_processing',
      'common.unsupported_type',
      'common.file_too_large',
      'common.error_try_again',
      'dev.echo_text',
      'dev.echo_media',
    ]) {
      expect(en).toHaveProperty([key]);
      expect(hi).toHaveProperty([key]);
    }
  });

  it('uses the same {{placeholders}} in both languages for every key', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '').sort();
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(hi[key])).toEqual(placeholders(en[key]));
    }
  });

  it('has no empty strings', () => {
    for (const value of [...Object.values(en), ...Object.values(hi)]) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('Hindi strings are written in Devanagari', () => {
    for (const [key, value] of Object.entries(hi)) {
      // Dev messages and the English language button ("English") are deliberately not Devanagari.
      // Skip dev messages and language-neutral strings ("English", "• {{name}} — {{timings}}").
      if (!key.startsWith('dev.') && value !== (en as Record<string, string>)[key]) {
        expect(value).toMatch(/[ऀ-ॿ]/);
      }
    }
  });

  it('keeps every message within the WhatsApp text limit', () => {
    for (const value of [...Object.values(en), ...Object.values(hi)]) {
      expect(value.length).toBeLessThan(4096);
    }
  });
});

describe('I18nService.t', () => {
  it('returns the translation for the requested language', () => {
    const i18n = make();
    expect(i18n.t('en', 'common.error_try_again')).toBe(en['common.error_try_again']);
    expect(i18n.t('hi', 'common.error_try_again')).toBe(hi['common.error_try_again']);
  });

  it('interpolates {{params}} (strings and numbers)', () => {
    const i18n = make();
    expect(i18n.t('en', 'common.file_too_large', { max_mb: 10 })).toContain('10 MB');
    expect(i18n.t('hi', 'dev.echo_text', { text: 'नमस्ते' })).toBe('[dev] आपने लिखा: नमस्ते');
    expect(i18n.t('en', 'dev.echo_media', { type: 'image', size_kb: 42 })).toBe(
      '[dev] Got your image (42 KB) and saved it.',
    );
  });

  it('interpolates every occurrence of a placeholder', () => {
    const i18n = make();
    Object.defineProperty(i18n, 'dictionaries', {
      value: { en: { 'dev.echo_text': '{{text}} / {{text}}' }, hi: {} },
    });
    expect(i18n.t('en', 'dev.echo_text', { text: 'a' })).toBe('a / a');
  });

  it('keeps the placeholder and warns when a parameter is missing', () => {
    const i18n = make();
    expect(i18n.t('en', 'common.file_too_large')).toContain('{{max_mb}}');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ param: 'max_mb' }),
      expect.any(String),
    );
  });

  it('does not treat "$&" or similar in a value as a regex replacement pattern', () => {
    const i18n = make();
    expect(i18n.t('en', 'dev.echo_text', { text: '$& $1 $$' })).toBe('[dev] You wrote: $& $1 $$');
  });

  it('falls back to English and warns when a key is missing in Hindi', () => {
    const i18n = make();
    Object.defineProperty(i18n, 'dictionaries', {
      value: { en: { 'dev.echo_text': 'EN {{text}}' }, hi: {} },
    });
    expect(i18n.t('hi', 'dev.echo_text', { text: 'x' })).toBe('EN x');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'dev.echo_text', language: 'hi' }),
      expect.stringContaining('fall'),
    );
  });

  it('returns the key itself (and logs an error) when it is missing everywhere', () => {
    const i18n = make();
    Object.defineProperty(i18n, 'dictionaries', { value: { en: {}, hi: {} } });
    expect(i18n.t('en', 'dev.echo_text')).toBe('dev.echo_text');
    expect(logger.error).toHaveBeenCalled();
  });
});
