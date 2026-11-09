import aliasData from '../common/safety/data/command-aliases.json';
import { normaliseForMatching } from '../common/safety/normalise';

export type CommandName =
  | 'help'
  | 'language'
  | 'delete'
  | 'stop_reminders'
  | 'start_reminders'
  | 'meds'
  | 'check'
  | 'reports'
  | 'reminders'
  | 'caregiver_add'
  | 'caregiver_remove'
  // M13: VOICE ON / VOICE OFF (spoken replies)
  | 'voice_on'
  | 'voice_off';

/**
 * Stable ids of the interactive buttons we send. Routing uses these ids, NEVER the visible titles
 * (titles are translated and users can see/edit nothing but the id is ours).
 */
export const BUTTON_ID = {
  langHi: 'lang:hi',
  langEn: 'lang:en',
  consentYes: 'consent:yes',
  consentNo: 'consent:no',
  deleteConfirm: 'delete:confirm',
  deleteCancel: 'delete:cancel',
  // M10: answer to the "your reminders end tomorrow" question
  renewYes: 'rem:renew:yes',
  renewNo: 'rem:renew:no',
  // M13: one-time notice for users who consented before voice notes existed (consent v2)
  voiceOk: 'voice:ok',
  voiceNo: 'voice:no',
} as const;

/**
 * Aliases per command come from ONE shared file (`packages/contracts/commands/aliases.json`, copied
 * here by `make safety-data`; a test fails when the copy is stale). The AI service reads the same
 * file to detect a command in a voice transcript. Matching is on the WHOLE normalised message, never
 * a substring: "help me with my medicine" or "please delete this from my prescription" must not
 * trigger HELP / DELETE. Aliases go through the same normaliser as the message.
 */
const ALIASES = aliasData.commands as Readonly<Record<CommandName, readonly string[]>>;

const LOOKUP: ReadonlyMap<string, CommandName> = new Map(
  (Object.entries(ALIASES) as [CommandName, readonly string[]][]).flatMap(([command, aliases]) =>
    aliases.map((alias): [string, CommandName] => [normaliseForMatching(alias), command]),
  ),
);

/**
 * Turn a message into a command, or null if it is not exactly a command.
 * Case, extra spaces, trailing punctuation and emoji are ignored ("HELP!!", " help 🙏 ").
 * A bare "?" means HELP.
 */
export function parseCommand(text: string): CommandName | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^[?？\s]+$/u.test(trimmed)) {
    return 'help';
  }
  return LOOKUP.get(normaliseForMatching(trimmed)) ?? null;
}

const CAREGIVER_ADD_PREFIX = /^(?:caregiver(?:\s+add)?|parivar\s+jodo)\s+([+\d][\d\s-]{6,20})$/iu;

/**
 * `CAREGIVER +91 98765 43210` / `parivar jodo 9876543210` -> the number as typed (digits, spaces,
 * dashes, a leading +), or null. Only the webhook calls this: the number is stored encrypted in Redis
 * right away and never enters a queue job.
 */
export function parseCaregiverAddNumber(text: string): string | null {
  const match = CAREGIVER_ADD_PREFIX.exec(text.trim());
  return match ? (match[1] as string).trim() : null;
}

/** Caregiver-side answers, matched on the whole message (they come from the caregiver's own number). */
export type CaregiverReply = 'yes' | 'no' | 'stop_alerts';

const CAREGIVER_REPLIES: ReadonlyMap<string, CaregiverReply> = new Map(
  [
    ['yes', 'yes'],
    ['haan', 'yes'],
    ['han', 'yes'],
    ['ha', 'yes'],
    ['हाँ', 'yes'],
    ['हां', 'yes'],
    ['no', 'no'],
    ['nahi', 'no'],
    ['nahin', 'no'],
    ['नहीं', 'no'],
    ['stop alerts', 'stop_alerts'],
    ['stop alert', 'stop_alerts'],
    ['alerts band karo', 'stop_alerts'],
  ].map(([alias, reply]) => [normaliseForMatching(alias as string), reply as CaregiverReply]),
);

export function parseCaregiverReply(text: string): CaregiverReply | null {
  return CAREGIVER_REPLIES.get(normaliseForMatching(text)) ?? null;
}
