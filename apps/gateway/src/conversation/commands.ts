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
  | 'caregiver_remove';

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
} as const;

/**
 * Aliases per command. Matching is on the WHOLE normalised message, never a substring: "help me with
 * my medicine" or "please delete this from my prescription" must not trigger HELP / DELETE.
 * Aliases go through the same normaliser as the message, so they can be written naturally.
 */
const ALIASES: Readonly<Record<CommandName, readonly string[]>> = {
  help: ['help', 'madad', 'मदद'],
  language: ['language', 'bhasha', 'भाषा', 'lang'],
  delete: ['delete', 'delete my data', 'data delete karo', 'डिलीट'],
  stop_reminders: ['stop reminders', 'stop reminder', 'reminder band karo', 'stop'],
  start_reminders: ['start reminders', 'start reminder', 'reminder chalu karo'],
  meds: ['meds', 'dawai', 'dawaiyan', 'दवाई'],
  // M11: re-run the interaction / duplicate-ingredient check on all active medicines
  check: ['check', 'jaanch karo', 'jaanch', 'जांच करो', 'जाँच करो', 'जांच'],
  // M12: the last lab reports, one tap to see a summary again
  reports: ['reports', 'my reports', 'reports dikhao', 'report dikhao', 'meri reports', 'रिपोर्ट'],
  reminders: ['reminders', 'reminder list', 'reminder dikhao', 'रिमाइंडर'],
  // 'caregiver_add' without a number also lands here: the handler explains the format.
  caregiver_add: ['caregiver', 'caregiver add', 'parivar jodo', 'परिवार जोड़ो'],
  caregiver_remove: ['caregiver remove', 'caregiver hatao', 'parivar hatao'],
};

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
