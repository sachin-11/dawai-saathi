import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { GenericDetailsRequest, ProcessMeta } from '../ai-client/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';
import {
  type ClockTimes,
  mapMedications,
  type PrescriptionExtraction,
} from './prescription.mapping';

export type DocumentStatusValue = 'done' | 'needs_review' | 'failed';

export interface SavedPrescription {
  documentId: string;
  status: DocumentStatusValue;
  /** False when this inbound message had already been saved (a retried job): nothing was inserted. */
  created: boolean;
}

/** The AI service puts this literal in its button ids; the gateway swaps in the real document id. */
export const DOCUMENT_ID_PLACEHOLDER = '{document_id}';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Saves what the AI service read from a prescription (CLAUDE.md §7.2 step 2) and handles the
 * "Something is wrong" button. The extraction JSON contains no PHI by construction (the AI service's
 * schema has no name/phone/address field), so it is stored as is.
 */
@Injectable()
export class PrescriptionService {
  private readonly clock: ClockTimes;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) env: Env,
  ) {
    this.clock = {
      morning: env.MED_TIME_MORNING,
      afternoon: env.MED_TIME_AFTERNOON,
      evening: env.MED_TIME_EVENING,
      night: env.MED_TIME_NIGHT,
    };
  }

  /**
   * ONE transaction: the document and all its medications, or nothing. Idempotent per inbound
   * message (`documents.message_id` is unique): reprocessing the same message returns the existing
   * document and inserts nothing, so a retried job cannot duplicate medicines.
   */
  async save(input: {
    userId: string;
    messageId: string;
    s3Key: string;
    extraction: PrescriptionExtraction;
    meta: Pick<ProcessMeta, 'model' | 'prompt_version'>;
    now?: Date;
  }): Promise<SavedPrescription> {
    const { extraction } = input;
    const status = extraction.status;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.document.findUnique({
          where: { messageId: input.messageId },
          select: { id: true, status: true },
        });
        if (existing) {
          return {
            documentId: existing.id,
            status: existing.status as DocumentStatusValue,
            created: false,
          };
        }

        const document = await tx.document.create({
          data: {
            userId: input.userId,
            messageId: input.messageId,
            kind: 'prescription',
            s3Key: input.s3Key,
            status,
            extraction: extraction,
            overallConfidence: extraction.overall_confidence,
            promptVersion: input.meta.prompt_version,
            model: input.meta.model ?? null,
          },
          select: { id: true },
        });

        // A failed read has no usable medicines: keep the document (history, admin review), save none.
        if (status !== 'failed') {
          const rows = mapMedications(extraction, this.clock, input.now ?? new Date());
          if (rows.length > 0) {
            await tx.medication.createMany({
              data: rows.map((row) => ({
                ...row,
                userId: input.userId,
                documentId: document.id,
              })),
            });
          }
        }
        return { documentId: document.id, status, created: true };
      });
    } catch (error) {
      // Two workers raced on the same message: the unique index let one win; return its document.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.document.findUniqueOrThrow({
          where: { messageId: input.messageId },
          select: { id: true, status: true },
        });
        return {
          documentId: existing.id,
          status: existing.status as DocumentStatusValue,
          created: false,
        };
      }
      throw error;
    }
  }

  /**
   * "Something is wrong": the document needs a human check and its medicines are switched off.
   * Returns the number of medicines deactivated, or null when the document does not exist or is not
   * this user's (the caller answers with the same neutral message either way).
   * M10 note: reminders of these medications must be cancelled by the reminder module.
   */
  async markWrong(userId: string, documentId: string): Promise<number | null> {
    if (!isUuid(documentId)) return null;
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.findFirst({
        where: { id: documentId, userId },
        select: { id: true },
      });
      if (!document) return null;
      await tx.document.update({ where: { id: document.id }, data: { status: 'needs_review' } });
      const result = await tx.medication.updateMany({
        where: { documentId: document.id, userId, active: true },
        data: { active: false },
      });
      return result.count;
    });
  }

  /**
   * The medicines of one of the user's prescriptions, with the generic suggestions stored when it was
   * read (names and prices as they were then). Null when the document is not found or not theirs.
   * Medicines whose name could not be read were never matched and are left out.
   */
  async genericItems(
    userId: string,
    documentId: string,
  ): Promise<GenericDetailsRequest['medicines'] | null> {
    if (!isUuid(documentId)) return null;
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, userId, kind: 'prescription' },
      select: { extraction: true },
    });
    if (!document) return null;
    const extraction = document.extraction as unknown as PrescriptionExtraction | null;
    return (extraction?.medicines ?? []).flatMap((medicine) =>
      medicine.name.value && medicine.match
        ? [
            {
              name: medicine.name.value,
              strength: medicine.strength.value ?? null,
              generic: medicine.generic ?? null,
            },
          ]
        : [],
    );
  }
}
