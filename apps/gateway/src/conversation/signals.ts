import { detectEmergency, type EmergencyKind } from '../common/safety/emergency-keywords';
import type { InboundMessage } from '../webhook/inbound-message';
import { parseAckText, type AckKind } from '../reminders/ack-parser';
import { type CommandName, parseCaregiverAddNumber, parseCommand } from './commands';

/**
 * What the router needs to know about a message's TEXT, reduced to small enums.
 *
 * The inbound queue never carries message text (it is PHI, CLAUDE.md §2.6), and pre-consent users'
 * text is not stored at all. The webhook already holds the text in memory, so it classifies it right
 * there and puts only these signals into the job. The router then routes without ever seeing text.
 */
export interface MessageSignals {
  emergency?: EmergencyKind;
  command?: CommandName;
  /** M10: the whole message is "le li" / "baad me" / "skip" (the router checks a reminder is open). */
  ack?: AckKind;
  /**
   * M10: the user was in the middle of a question (caregiver label, new reminder times). The webhook
   * stored the text, ENCRYPTED, in Redis for a few minutes; the router reads it from there.
   */
  input?: true;
}

/** Classify one inbound message. Button taps are routed by their id, never by their title. */
export function classifyInbound(message: InboundMessage): MessageSignals {
  const signals: MessageSignals = {};
  if (message.type === 'button' || message.text === undefined) {
    return signals;
  }
  // Captions count for the emergency check too ("photo of my father, he is unconscious").
  const emergency = detectEmergency(message.text);
  if (emergency) {
    signals.emergency = emergency;
  }
  if (message.type === 'text') {
    const command =
      parseCommand(message.text) ??
      (parseCaregiverAddNumber(message.text) !== null ? 'caregiver_add' : null);
    if (command) {
      signals.command = command;
    } else {
      const ack = parseAckText(message.text);
      if (ack) {
        signals.ack = ack;
      }
    }
  }
  return signals;
}
