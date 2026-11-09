import aliasData from '../common/safety/data/command-aliases.json';
import { normaliseForMatching } from '../common/safety/normalise';

export type AckKind = 'taken' | 'snooze' | 'skip';

/** Button ids: `rem:<kind>:<slot epoch seconds>`. The user is the sender, never part of the id. */
export const REMINDER_BUTTON = /^rem:(taken|snooze|skip):(\d{9,12})$/;

export function reminderButtonId(kind: AckKind, epoch: number): string {
  return `rem:${kind}:${epoch}`;
}

export function parseReminderButton(buttonId: string): { kind: AckKind; epoch: number } | null {
  const match = REMINDER_BUTTON.exec(buttonId);
  return match ? { kind: match[1] as AckKind, epoch: Number(match[2]) } : null;
}

const ALIASES = aliasData.acks as Readonly<Record<AckKind, readonly string[]>>;

const LOOKUP: ReadonlyMap<string, AckKind> = new Map(
  (Object.entries(ALIASES) as [AckKind, readonly string[]][]).flatMap(([kind, aliases]) =>
    aliases.map((alias): [string, AckKind] => [normaliseForMatching(alias), kind]),
  ),
);

/**
 * A text reply to a reminder: WHOLE-message match only. Anything else ("ha mujhe ek sawal hai") is
 * not an ack and takes the normal path. Emoji are stripped by the normaliser, so a message that is
 * only a check mark is handled first.
 */
export function parseAckText(text: string): AckKind | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (/^[\s✅✔☑👍]+$/u.test(trimmed)) return 'taken';
  return LOOKUP.get(normaliseForMatching(trimmed)) ?? null;
}
