import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { AiClient, toRequestId } from '../ai-client/ai-client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUuid } from '../documents/prescription.service';
import { MedicationWarningsService } from '../medications/medication-warnings.service';
import type { UserState } from '../users/users.service';
import { UsersService } from '../users/users.service';
import { AI_ERROR_REPLY_INDEX } from './reply-indexes';
import type { ReplySession } from './replies.service';

/** `ix:details:<document id>` (one prescription) or `ix:details:all` (after CHECK). */
const IX_BUTTON = /^ix:details:([^:\s]{1,64})$/;
export const IX_ALL = 'all';

export interface IxButton {
  /** A document id, or `all`. */
  target: string;
}

/** `ix:details:<id>` -> `{target}`; anything else (also a malformed id) -> null. */
export function parseIxButton(buttonId: string): IxButton | null {
  const match = IX_BUTTON.exec(buttonId);
  if (!match) return null;
  const target = match[1] as string;
  return target === IX_ALL || isUuid(target) ? { target } : null;
}

export function ixDetailsButtonId(target: string): string {
  return `ix:details:${target}`;
}

export type IxOutcome = 'ix_details' | 'ix_none' | 'ix_not_found' | 'check_done' | 'check_need_two';

/**
 * Interaction checks that are not part of reading a prescription (M11):
 *   CHECK                   re-run the check on ALL active medicines (every prescription, every doctor)
 *   [Interaction details]   the stored warnings, rendered by the AI service from the current rows
 * The gateway owns the user's state (medications, warnings); the AI service only looks things up.
 */
@Injectable()
export class InteractionFlowService {
  constructor(
    private readonly ai: AiClient,
    private readonly warnings: MedicationWarningsService,
    private readonly users: UsersService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InteractionFlowService.name);
  }

  /** The follow-up button message (the main reply already uses WhatsApp's three buttons). */
  offerDetails(session: ReplySession, target: string): Promise<void> {
    return session.rawButtonsWithPrompt('interaction.details_prompt', [
      { id: ixDetailsButtonId(target), title: session.translate('interaction.details_button') },
    ]);
  }

  /** CHECK / "jaanch karo". */
  async check(user: UserState, session: ReplySession): Promise<IxOutcome> {
    const medications = await this.users.activeMedicationSalts(user.id);
    if (medications.length < 2) {
      await session.text('check.need_two');
      return 'check_need_two';
    }
    try {
      const response = await this.ai.interactionCheck({
        request_id: toRequestId(`${session.requestId}-check`),
        language: user.language,
        medications,
      });
      const findings = response.interactions.findings ?? [];
      const stats = await this.warnings.syncAll(user.id, response.interactions);
      this.logger.info(
        {
          user_id: user.id,
          medicines: medications.length,
          findings: findings.length,
          created: stats.created,
          resolved: stats.resolved,
        },
        'interaction check done',
      );
      await session.rawText(response.reply.text);
      if (findings.length > 0) {
        await this.offerDetails(session, IX_ALL);
      }
    } catch (error) {
      await session.textAt(AI_ERROR_REPLY_INDEX, 'common.error_try_again').catch(() => undefined);
      throw error;
    }
    return 'check_done';
  }

  /** The details button. Unknown or foreign document ids get the same neutral answer. */
  async details(user: UserState, button: IxButton, session: ReplySession): Promise<IxOutcome> {
    let onlyIds: string[] | undefined;
    if (button.target !== IX_ALL) {
      const document = await this.prisma.document.findFirst({
        where: { id: button.target, userId: user.id },
        select: { id: true },
      });
      if (!document) {
        await session.text('rx.not_found');
        return 'ix_not_found';
      }
      const rows = await this.prisma.medication.findMany({
        where: { documentId: document.id, userId: user.id },
        select: { id: true },
      });
      onlyIds = rows.map((row) => row.id);
    }
    const warnings = await this.warnings.listActive(user.id, onlyIds);
    if (warnings.length === 0) {
      await session.text('interaction.details_none');
      return 'ix_none';
    }
    const active = await this.users.activeMedicationSalts(user.id);
    try {
      const response = await this.ai.interactionDetails({
        request_id: toRequestId(`${session.requestId}-ixdetails`),
        language: user.language,
        warnings: warnings.map((w) => ({
          type: w.type,
          salt_a: w.saltA,
          salt_b: w.saltB,
          labels: w.labels,
        })),
        unchecked: active
          .filter((m) => !m.salt_key)
          .map((m) => ({ ref: m.medication_id ?? 'unknown', label: m.name ?? null })),
        checked_count: active.filter((m) => m.salt_key).length,
      });
      await session.rawText(response.reply.text);
    } catch (error) {
      await session.textAt(AI_ERROR_REPLY_INDEX, 'common.error_try_again').catch(() => undefined);
      throw error;
    }
    return 'ix_details';
  }
}
