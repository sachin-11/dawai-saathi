import { detectEmergency, type EmergencyKind } from '../common/safety/emergency-keywords';
import type { InboundMessage } from '../webhook/inbound-message';
import { type CommandName, parseCommand } from './commands';

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
    const command = parseCommand(message.text);
    if (command) {
      signals.command = command;
    }
  }
  return signals;
}
