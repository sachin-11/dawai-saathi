import { Injectable } from '@nestjs/common';

import { I18nService, type Language } from '../messaging/i18n/i18n.service';
import type { OutboundRequest } from '../messaging/outbound.types';
import { reminderButtonId } from './ack-parser';
import { epochSeconds, localTimeOf } from './clock';

export interface DueMedicine {
  name: string;
  /** As written on the prescription ("1 tablet"), or null. */
  dose: string | null;
  food: 'before' | 'after' | 'with' | 'any';
}

/** WhatsApp button bodies hold 1024 characters; stay below it. */
const MAX_BODY = 900;

/**
 * Builds the dose-reminder message for ONE slot: every medicine due at that time in a single message
 * (fewer messages, less fatigue). Inside the 24 h window it is an interactive message with three
 * buttons; outside it is the approved `dose_reminder` template with the same three payloads. All text
 * comes from i18n and the medicine data in the DB: no LLM (CLAUDE.md §2.5).
 */
@Injectable()
export class ReminderMessages {
  constructor(private readonly i18n: I18nService) {}

  private details(language: Language, medicine: DueMedicine): string {
    const parts: string[] = [];
    if (medicine.dose) parts.push(medicine.dose);
    if (medicine.food !== 'any')
      parts.push(this.i18n.t(language, `reminder.food.${medicine.food}`));
    return parts.join(', ');
  }

  slotRequest(input: {
    language: Language;
    timezone: string;
    scheduledAt: Date;
    medicines: readonly DueMedicine[];
    sourceMessageId: string;
    replyIndex: number;
    requestId?: string;
  }): OutboundRequest {
    const { language, scheduledAt, medicines } = input;
    const time = localTimeOf(scheduledAt, input.timezone);
    const epoch = epochSeconds(scheduledAt);

    const lines: string[] = [];
    let used = 0;
    for (const [index, medicine] of medicines.entries()) {
      const details = this.details(language, medicine);
      const line = this.i18n.t(language, 'reminder.line', {
        name: medicine.name,
        details: details ? ` — ${details}` : '',
      });
      if (used + line.length > MAX_BODY && lines.length > 0) {
        lines.push(this.i18n.t(language, 'reminder.more', { count: medicines.length - index }));
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }

    const ids = {
      taken: reminderButtonId('taken', epoch),
      snooze: reminderButtonId('snooze', epoch),
      skip: reminderButtonId('skip', epoch),
    };
    const templateMedicines = medicines
      .map((medicine) => {
        const details = this.details(language, medicine);
        return details ? `${medicine.name} (${details})` : medicine.name;
      })
      .join('; ')
      .slice(0, MAX_BODY);

    return {
      content: {
        kind: 'buttons',
        body: this.i18n.t(language, 'reminder.body', { time, lines: lines.join('\n') }),
        buttons: [
          { id: ids.taken, title: this.i18n.t(language, 'reminder.btn.taken') },
          { id: ids.snooze, title: this.i18n.t(language, 'reminder.btn.snooze') },
          { id: ids.skip, title: this.i18n.t(language, 'reminder.btn.skip') },
        ],
      },
      templateFallback: {
        kind: 'template',
        template: 'dose_reminder',
        language,
        params: { medicines: templateMedicines, time },
        buttonPayloads: [ids.taken, ids.snooze, ids.skip],
      },
      sourceMessageId: input.sourceMessageId,
      replyIndex: input.replyIndex,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    };
  }
}
