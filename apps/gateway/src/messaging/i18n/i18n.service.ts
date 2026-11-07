import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import en from './en.json';
import hi from './hi.json';

export type Language = 'hi' | 'en';
export type MessageKey = keyof typeof en;

type Dictionary = Readonly<Record<string, string>>;

/** Every user-facing string lives in `i18n/{hi,en}.json` (CLAUDE.md §10): no hard-coded text in services. */
@Injectable()
export class I18nService {
  private readonly dictionaries: Readonly<Record<Language, Dictionary>> = { en, hi };

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(I18nService.name);
  }

  /**
   * Translate `key` into `language`, filling `{{param}}` placeholders.
   * A key missing in Hindi falls back to English (and logs a warning); a key missing everywhere
   * returns the key itself so the bug is visible instead of crashing the reply.
   */
  t(
    language: Language,
    key: MessageKey,
    params: Readonly<Record<string, string | number>> = {},
  ): string {
    let template = this.dictionaries[language][key];
    if (template === undefined) {
      this.logger.warn({ key, language }, 'missing translation, falling back to English');
      template = this.dictionaries.en[key];
    }
    if (template === undefined) {
      this.logger.error({ key }, 'translation key missing in every language');
      return key;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
      const value = params[name];
      if (value === undefined) {
        this.logger.warn({ key, param: name }, 'missing i18n parameter');
        return placeholder;
      }
      return String(value);
    });
  }
}
