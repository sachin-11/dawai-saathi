import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { MedicationWarningsService } from '../medications/medication-warnings.service';
import { ReminderScheduleService } from '../reminders/reminder-schedule.service';
import {
  type ActiveMedicationLine,
  type UserLanguage,
  type UserState,
  UsersService,
} from '../users/users.service';
import type { ReplySession } from './replies.service';
import { LANGUAGE_BUTTONS } from './onboarding.service';

/** Commands for fully onboarded users: HELP, LANGUAGE, STOP/START REMINDERS, MEDS. */
@Injectable()
export class CommandHandlersService {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly schedules: ReminderScheduleService,
    private readonly warnings: MedicationWarningsService,
  ) {}

  help(session: ReplySession): Promise<void> {
    return session.text('help.body');
  }

  /** LANGUAGE: show the language buttons again. */
  askLanguage(session: ReplySession): Promise<void> {
    return session.buttons('onboarding.choose_language', {}, LANGUAGE_BUTTONS);
  }

  /** The user picked a language: save it and confirm IN the new language. */
  async setLanguage(user: UserState, language: UserLanguage, session: ReplySession): Promise<void> {
    await this.users.setLanguage(user.id, language);
    session.useLanguage(language);
    if (user.language !== language) {
      await this.audit.log({
        actor: 'user',
        userId: user.id,
        action: 'language_changed',
        metadata: { language },
      });
    }
    await session.text('language.changed');
  }

  /**
   * STOP REMINDERS / START REMINDERS. Sets `users.reminders_enabled`, then cancels what is queued
   * (STOP) or plans the next hours again (START). The schedules themselves stay.
   */
  async setReminders(user: UserState, enabled: boolean, session: ReplySession): Promise<void> {
    await this.users.setRemindersEnabled(user.id, enabled);
    if (enabled) {
      await this.schedules.resumeAll(user.id);
    } else {
      await this.schedules.suspendAll(user.id);
    }
    if (user.remindersEnabled !== enabled) {
      await this.audit.log({
        actor: 'user',
        userId: user.id,
        action: enabled ? 'reminders_enabled' : 'reminders_disabled',
      });
    }
    await session.text(enabled ? 'reminders.enabled' : 'reminders.disabled');
  }

  /** MEDS: the user's active medicines (populated by the prescription flow from M7 on). */
  async meds(user: UserState, session: ReplySession): Promise<void> {
    const medications = await this.users.activeMedications(user.id);
    if (medications.length === 0) {
      await session.text('meds.none');
      return;
    }
    const today = await this.schedules.todayStatus(user.id);
    // M11: a medicine that is part of an active interaction / duplicate warning gets a marker.
    const flagged = await this.warnings.medicationIdsWithWarnings(user.id);
    // One message: separate replies could arrive out of order.
    await session.textLines(
      flagged.size > 0 ? 'meds.list_header_warn' : 'meds.list_header',
      medications.map((medication) => ({
        key: 'meds.item' as const,
        params: {
          name: flagged.has(medication.id) ? `⚠️ ${medication.name}` : medication.name,
          timings:
            this.describeToday(today.get(medication.id)) ??
            this.describeSchedule(medication, session),
        },
      })),
    );
  }

  /** "08:00 ✅, 21:00 ⏳" for the doses scheduled today, or null when there are none. */
  private describeToday(
    entries: readonly { time: string; status: string }[] | undefined,
  ): string | null {
    const shown = (entries ?? []).filter((entry) => entry.status !== 'cancelled');
    if (shown.length === 0) return null;
    const icon: Record<string, string> = {
      taken: '✅',
      skipped: '⏭️',
      missed: '❌',
      pending: '⏳',
      sent: '⏳',
      snoozed: '⏳',
    };
    return shown.map((entry) => `${entry.time} ${icon[entry.status] ?? ''}`.trim()).join(', ');
  }

  /** Clock times when saved, otherwise "only when needed" / "N times a day", otherwise a dash. */
  private describeSchedule(medication: ActiveMedicationLine, session: ReplySession): string {
    if (medication.timings.length > 0) return medication.timings.join(', ');
    if (medication.asNeeded) return session.translate('meds.when_as_needed');
    if (medication.frequencyPerDay !== null) {
      return session.translate('meds.when_times', { count: medication.frequencyPerDay });
    }
    return '–';
  }
}
