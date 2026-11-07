import { Injectable } from '@nestjs/common';

import type { TemplateComponent } from './whatsapp.client';
import { WhatsAppValidationError } from './whatsapp.errors';

export type TemplateLanguage = 'hi' | 'en';
export type TemplateName =
  'dose_reminder' | 'caregiver_missed_dose_alert' | 'consent_reminder' | 'generic_reengage';

interface TemplateDefinition {
  /** Template name as registered with Meta (see docs/whatsapp-templates.md). */
  metaName: string;
  /** Body variables in `{{1}}`, `{{2}}`… order: the keys callers must provide. */
  bodyParams: readonly string[];
  /** Number of quick-reply buttons; the caller supplies one payload per button. */
  quickReplyButtons: number;
}

/**
 * Our internal template names -> what Meta knows. Nothing else in the codebase builds template JSON
 * by hand: services say `build('dose_reminder', 'hi', { medicine_name, dose_timing }, payloads)`.
 * Meta language codes: `hi` (Hindi) and `en` (English).
 */
export const TEMPLATES: Readonly<Record<TemplateName, TemplateDefinition>> = {
  dose_reminder: {
    metaName: 'dose_reminder',
    bodyParams: ['medicine_name', 'dose_timing'],
    quickReplyButtons: 3, // Taken / Snooze / Skip
  },
  caregiver_missed_dose_alert: {
    metaName: 'caregiver_missed_dose_alert',
    bodyParams: ['patient_label', 'medicine_name', 'due_time'],
    quickReplyButtons: 0,
  },
  consent_reminder: {
    metaName: 'consent_reminder',
    bodyParams: [],
    quickReplyButtons: 2, // I agree / Not now
  },
  generic_reengage: {
    metaName: 'generic_reengage',
    bodyParams: [],
    quickReplyButtons: 0,
  },
};

export interface BuiltTemplate {
  name: string;
  languageCode: string;
  components: TemplateComponent[];
}

/** Meta caps a quick-reply payload at 128 characters. */
const MAX_PAYLOAD_LENGTH = 128;

@Injectable()
export class TemplateRegistry {
  has(name: string): name is TemplateName {
    return Object.hasOwn(TEMPLATES, name);
  }

  /**
   * Turn an internal template reference into the exact Graph API fields. Throws
   * WhatsAppValidationError when parameters or button payloads do not match the definition, so a
   * wrong call fails in our code instead of as an opaque Meta error.
   */
  build(
    name: TemplateName,
    language: TemplateLanguage,
    params: Readonly<Record<string, string>> = {},
    buttonPayloads: readonly string[] = [],
  ): BuiltTemplate {
    const definition = TEMPLATES[name];

    const bodyParameters = definition.bodyParams.map((key) => {
      const value = params[key];
      if (value === undefined || value.trim() === '') {
        throw new WhatsAppValidationError(`template ${name}: missing parameter "${key}"`);
      }
      // Meta rejects newlines, tabs and 4+ consecutive spaces in template parameters.
      const text = value
        .replace(/[\n\t]+/g, ' ')
        .replace(/ {4,}/g, '   ')
        .trim();
      return { type: 'text' as const, text };
    });

    if (buttonPayloads.length !== definition.quickReplyButtons) {
      throw new WhatsAppValidationError(
        `template ${name}: expected ${definition.quickReplyButtons} button payload(s), got ${buttonPayloads.length}`,
      );
    }

    const components: TemplateComponent[] = [];
    if (bodyParameters.length > 0) {
      components.push({ type: 'body', parameters: bodyParameters });
    }
    buttonPayloads.forEach((payload, index) => {
      if (payload.length < 1 || payload.length > MAX_PAYLOAD_LENGTH) {
        throw new WhatsAppValidationError(
          `template ${name}: button payload must be 1–${MAX_PAYLOAD_LENGTH} characters`,
        );
      }
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload }],
      });
    });

    return { name: definition.metaName, languageCode: language, components };
  }
}
