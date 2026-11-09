import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PreviousLabResult, ProcessMeta } from '../ai-client/types';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  isOutside,
  type LabReportExtraction,
  mapLabResults,
  reportDateOf,
} from './lab-report.mapping';
import { type DocumentStatusValue, isUuid } from './prescription.service';

/** Trends look back this far (CLAUDE.md M12: the user's previous lab reports, last 12 months). */
export const TREND_WINDOW_MONTHS = 12;
const MAX_PREVIOUS_ROWS = 600;
export const REPORTS_LIMIT = 5;

export interface SavedLabReport {
  documentId: string;
  status: DocumentStatusValue;
  /** False when this inbound message had already been saved (a retried job): nothing was inserted. */
  created: boolean;
}

export interface ReportSummary {
  documentId: string;
  /** The date printed on the report, or null when it was not readable (then `createdAt` is shown). */
  reportDate: Date | null;
  createdAt: Date;
  tests: number;
  outside: number;
}

/**
 * Saves what the AI service read from a lab report (CLAUDE.md §7.3) and serves the history: trends
 * context, the REPORTS list, the "see all tests" / "something is wrong" buttons. The extraction JSON has
 * no PHI by construction (no name / id field in the AI service schema); age and sex live ONLY in it,
 * never on `users` (data minimisation, DPDP).
 */
@Injectable()
export class LabReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** ONE transaction: the document and its results, or nothing. Idempotent per inbound message. */
  async save(input: {
    userId: string;
    messageId: string;
    s3Key: string;
    extraction: LabReportExtraction;
    meta: Pick<ProcessMeta, 'model' | 'prompt_version'>;
  }): Promise<SavedLabReport> {
    const { extraction } = input;
    const status: DocumentStatusValue = extraction.status;
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
            kind: 'lab_report',
            s3Key: input.s3Key,
            status,
            extraction: extraction,
            overallConfidence: extraction.overall_confidence,
            promptVersion: input.meta.prompt_version,
            model: input.meta.model ?? null,
          },
          select: { id: true },
        });
        if (status !== 'failed') {
          const reportDate = reportDateOf(extraction);
          const rows = mapLabResults(extraction);
          if (rows.length > 0) {
            await tx.labResult.createMany({
              data: rows.map((row) => ({
                ...row,
                userId: input.userId,
                documentId: document.id,
                reportDate,
              })),
            });
          }
        }
        return { documentId: document.id, status, created: true };
      });
    } catch (error) {
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
   * `context.previous_lab_results`: canonical code, value, unit and date of the user's earlier
   * results (last 12 months). Nothing else. Reports marked "something is wrong" or read with low
   * confidence (`needs_review`) and failed reads are left out.
   */
  async previousResults(userId: string, now: Date = new Date()): Promise<PreviousLabResult[]> {
    const since = new Date(now);
    since.setUTCMonth(since.getUTCMonth() - TREND_WINDOW_MONTHS);
    const rows = await this.prisma.labResult.findMany({
      where: {
        userId,
        testCode: { not: null },
        valueNumCanonical: { not: null },
        unitCanonical: { not: null },
        reportDate: { not: null, gte: since },
        document: { status: 'done' },
      },
      select: {
        testCode: true,
        valueNumCanonical: true,
        unitCanonical: true,
        reportDate: true,
      },
      orderBy: { reportDate: 'desc' },
      take: MAX_PREVIOUS_ROWS,
    });
    return rows.flatMap((row) =>
      row.testCode && row.valueNumCanonical !== null && row.unitCanonical && row.reportDate
        ? [
            {
              test_code: row.testCode,
              value: Number(row.valueNumCanonical),
              unit: row.unitCanonical,
              report_date: row.reportDate.toISOString().slice(0, 10),
            },
          ]
        : [],
    );
  }

  /** "Something is wrong": the document needs a human check and leaves the trends. False if not theirs. */
  async markWrong(userId: string, documentId: string): Promise<boolean> {
    if (!isUuid(documentId)) return false;
    const result = await this.prisma.document.updateMany({
      where: { id: documentId, userId, kind: 'lab_report' },
      data: { status: 'needs_review' },
    });
    return result.count > 0;
  }

  /** The stored extraction of one of the user's lab reports, or null (also for a foreign id). */
  async extractionOf(userId: string, documentId: string): Promise<LabReportExtraction | null> {
    if (!isUuid(documentId)) return null;
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, userId, kind: 'lab_report', status: { not: 'failed' } },
      select: { extraction: true },
    });
    return (document?.extraction as unknown as LabReportExtraction | null) ?? null;
  }

  /** The user's last reports, newest first (REPORTS). */
  async recent(userId: string, limit = REPORTS_LIMIT): Promise<ReportSummary[]> {
    const documents = await this.prisma.document.findMany({
      where: { userId, kind: 'lab_report', status: { not: 'failed' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        labResults: { select: { status: true, reportDate: true } },
      },
    });
    return documents.map((document) => ({
      documentId: document.id,
      reportDate: document.labResults.find((r) => r.reportDate)?.reportDate ?? null,
      createdAt: document.createdAt,
      tests: document.labResults.length,
      outside: document.labResults.filter((r) => isOutside(r.status)).length,
    }));
  }
}
