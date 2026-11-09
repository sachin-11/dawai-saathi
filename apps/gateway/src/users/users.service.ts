import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { ActiveMedicationContext } from '../ai-client/types';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';

export type OnboardingStep = 'language' | 'consent' | 'done';
export type UserLanguage = 'hi' | 'en';

/** The slice of a user the conversation layer needs. No phone number (hash or ciphertext) in here. */
export interface UserState {
  id: string;
  language: UserLanguage;
  onboardingStep: OnboardingStep;
  consentAt: Date | null;
  remindersEnabled: boolean;
  /** M13: the consent text version the user accepted ("v2" mentions speech services). */
  consentVersion: string | null;
  /** M13: VOICE ON. Needs TTS_ENABLED as well. */
  voiceReplies: boolean;
  /** Set while an erasure (DELETE) is in flight. */
  deletedAt: Date | null;
}

/** The AI contract accepts at most 50 stored medicines as context. */
const MAX_CONTEXT_MEDICATIONS = 50;

const USER_SELECT = {
  id: true,
  language: true,
  onboardingStep: true,
  consentAt: true,
  remindersEnabled: true,
  consentVersion: true,
  voiceReplies: true,
  deletedAt: true,
} as const;

export interface ActiveMedicationLine {
  id: string;
  name: string;
  timings: string[];
  frequencyPerDay: number | null;
  asNeeded: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Find the user for a phone number or create one (language `hi`, onboarding step `language`, no
   * consent yet).
   *
   * The number is never stored in the clear: lookup uses the peppered hash, and the number is kept
   * encrypted (`wa_phone_enc`) only so we can message the user later. `upsert` on the unique hash is
   * a single atomic INSERT ... ON CONFLICT, so two concurrent first messages create ONE user.
   */
  async findOrCreateByPhone(phone: string): Promise<UserState> {
    const waPhoneHash = this.crypto.hashPhone(phone);
    const create = (): Promise<UserState> =>
      this.prisma.user.upsert({
        where: { waPhoneHash },
        create: {
          waPhoneHash,
          waPhoneEnc: this.crypto.encrypt(this.crypto.normalisePhone(phone)),
        },
        update: {},
        select: USER_SELECT,
      });

    try {
      return await create();
    } catch (error) {
      // Defensive: if the driver still reports a unique violation under a race, the row exists now.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.user.findUniqueOrThrow({ where: { waPhoneHash }, select: USER_SELECT });
      }
      throw error;
    }
  }

  /** Current state of a user, or null if the user no longer exists (erased). */
  getState(userId: string): Promise<UserState | null> {
    return this.prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
  }

  /**
   * Record when the user last wrote to us (drives the 24-hour WhatsApp window in M3/M10).
   * Only ever moves forward, so a retried or out-of-order old message cannot extend the window.
   */
  async touchLastInbound(userId: string, at: Date): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }] },
      data: { lastInboundAt: at },
    });
  }

  /**
   * First language choice: save it and move `language` -> `consent`. Conditional on the current
   * step, so a double tap or a retried job cannot move the user twice. Returns true if it moved.
   */
  async chooseLanguage(userId: string, language: UserLanguage): Promise<boolean> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, onboardingStep: 'language' },
      data: { language, onboardingStep: 'consent' },
    });
    return result.count > 0;
  }

  /** Change the language without touching the onboarding step. */
  async setLanguage(userId: string, language: UserLanguage): Promise<void> {
    await this.prisma.user.updateMany({ where: { id: userId }, data: { language } });
  }

  /**
   * The user accepted the consent text: record when and which version, and finish onboarding.
   * Conditional on step `consent`; returns true only for the call that actually moved the user.
   */
  async acceptConsent(userId: string, version: string, at: Date = new Date()): Promise<boolean> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, onboardingStep: 'consent' },
      data: { consentAt: at, consentVersion: version, onboardingStep: 'done' },
    });
    return result.count > 0;
  }

  async setVoiceReplies(userId: string, enabled: boolean): Promise<void> {
    await this.prisma.user.updateMany({ where: { id: userId }, data: { voiceReplies: enabled } });
  }

  /**
   * M13: a user who consented before voice notes existed saw the one-time notice and tapped OK.
   * Conditional on an OLDER version; returns true only for the call that actually moved the user.
   */
  async acceptVoiceNotice(userId: string, version: string): Promise<boolean> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, onboardingStep: 'done', NOT: { consentVersion: version } },
      data: { consentVersion: version },
    });
    return result.count > 0;
  }

  async setRemindersEnabled(userId: string, enabled: boolean): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { remindersEnabled: enabled },
    });
  }

  /** Active medicines for the MEDS command (filled by the prescription flow from M7 on). */
  async activeMedications(userId: string): Promise<ActiveMedicationLine[]> {
    const rows = await this.prisma.medication.findMany({
      where: { userId, active: true },
      orderBy: { rawName: 'asc' },
      select: { id: true, rawName: true, timings: true, frequencyPerDay: true, asNeeded: true },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.rawName,
      timings: row.timings,
      frequencyPerDay: row.frequencyPerDay,
      asNeeded: row.asNeeded,
    }));
  }

  /**
   * ALL of the user's active medicines (from every prescription and doctor): the context sent to
   * the AI service. M11 needs the ones without a salt too, so they are reported as "could not be
   * checked" instead of silently skipped; `salt_key` is only set where the interaction checker
   * resolved it with certainty.
   */
  async activeMedicationSalts(userId: string): Promise<ActiveMedicationContext[]> {
    const rows = await this.prisma.medication.findMany({
      where: { userId, active: true },
      orderBy: { id: 'asc' },
      take: MAX_CONTEXT_MEDICATIONS,
      select: {
        id: true,
        rawName: true,
        salt: true,
        strength: true,
        saltKey: true,
        strengthKey: true,
      },
    });
    return rows.map((row) => ({
      salt: row.salt,
      strength: row.strength,
      medication_id: row.id,
      name: row.rawName.slice(0, 200),
      salt_key: row.saltKey,
      strength_key: row.strengthKey,
    }));
  }

  /**
   * Mark that an erasure is running. Only the first caller sets it; the router ignores such users
   * while the deletion job works. (The job then hard-deletes the row.)
   */
  async markDeletionPending(userId: string, at: Date = new Date()): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, deletedAt: null },
      data: { deletedAt: at },
    });
  }

  /** The encrypted phone number, only for the erasure job's final message. */
  async getEncryptedPhone(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { waPhoneEnc: true },
    });
    return user?.waPhoneEnc ?? null;
  }
}
