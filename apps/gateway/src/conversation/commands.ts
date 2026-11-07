import { normaliseForMatching } from '../common/safety/normalise';

export type CommandName =
  'help' | 'language' | 'delete' | 'stop_reminders' | 'start_reminders' | 'meds';

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
