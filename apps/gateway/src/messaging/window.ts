/** WhatsApp customer-service window: free-form messages are only allowed for 24 h after the user's last message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Is a free-form (non-template) message allowed right now?
 *
 * Strictly less than 24 h since the user last wrote. Exactly 24 h counts as CLOSED: being one
 * millisecond conservative is cheaper than a `131047` from Meta. A user who never wrote
 * (`null`) has no window. This is the single place the rule lives (CLAUDE.md §7.4).
 */
export function isWithinWindow(
  lastInboundAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) {
    return false;
  }
  return now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

/** A free-form message was requested outside the 24 h window and no template fallback was given. */
export class WindowClosedError extends Error {
  constructor() {
    super('24-hour window closed: only template messages can be sent');
    this.name = 'WindowClosedError';
  }
}
