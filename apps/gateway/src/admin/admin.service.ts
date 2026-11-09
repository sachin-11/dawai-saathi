import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { BudgetService } from '../limits/budget.service';
import { DlqAdminService, assertSourceQueue } from '../telemetry/dlq-admin.service';
import { DLQ_SOURCE_QUEUES } from '../telemetry/dlq.service';
import { AdminError } from './admin.errors';

export const REVIEW_LABELS = [
  'correct',
  'extraction_wrong',
  'unreadable',
  'not_a_document',
] as const;
export type ReviewLabelName = (typeof REVIEW_LABELS)[number];

/** Documents read with less confidence than this go to the review queue (the AI service's default). */
export const REVIEW_CONFIDENCE_BELOW = 0.75;
export const REVEAL_URL_TTL_S = 60;
export const MIN_REASON_CHARS = 10;

export const STATS_RANGES = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type StatsRange = keyof typeof STATS_RANGES;

export interface StatsResult {
  range: StatsRange;
  users: { total: number; new: number; active7d: number };
  documentsByDay: { day: string; kind: string; n: number }[];
  averageConfidence: number | null;
  needsReview: number;
  reminders: { taken: number; missed: number; skipped: number; ackRate: number | null };
  emergenciesByCategory: { category: string; n: number }[];
  costByDay: { day: string; usd: number; demoUsd: number }[];
  budget: {
    state: string;
    spentUsd: number;
    ratio: number;
    demoExhausted: boolean;
    demoSpentUsd: number;
  };
}
export interface ReviewItem {
  id: string;
  userId: string;
  kind: string;
  status: string;
  createdAt: string;
  confidence: number | null;
  promptVersion: string | null;
  model: string | null;
  warnings: { lowConfidenceItems: number; critical: boolean };
  reviewLabel: string | null;
  reviewedAt: string | null;
}
export interface ReviewQueuePage {
  items: ReviewItem[];
  nextCursor: string | null;
}
export interface RevealResult {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  confidence: number | null;
  promptVersion: string | null;
  extraction: unknown;
  imageUrl: string;
  imageExpiresInS: number;
}
export interface DlqOverview {
  queues: { queue: string; size: number; entries: unknown[] }[];
}

const DAY_MS = 86_400_000;

function hashRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Counts only: how many items of an extraction were unclear, never what they say. */
export function reviewSignals(extraction: unknown): {
  lowConfidenceItems: number;
  critical: boolean;
} {
  const ex = extraction as
    | {
        medicines?: { low_confidence?: boolean }[];
        results?: { needs_confirmation?: boolean; status?: string }[];
        has_critical?: boolean;
      }
    | null
    | undefined;
  const lowMedicines = (ex?.medicines ?? []).filter((m) => m.low_confidence === true).length;
  const lowResults = (ex?.results ?? []).filter((r) => r.needs_confirmation === true).length;
  return {
    lowConfidenceItems: lowMedicines + lowResults,
    critical:
      ex?.has_critical === true ||
      (ex?.results ?? []).some((r) => r.status === 'critical_high' || r.status === 'critical_low'),
  };
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
    const createdAt = new Date(iso ?? '');
    if (Number.isNaN(createdAt.getTime()) || !id || !/^[0-9a-f-]{36}$/.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly budget: BudgetService,
    private readonly dlq: DlqAdminService,
  ) {}

  // ------------------------------------------------------------------ stats

  async stats(range: StatsRange, now: Date = new Date()): Promise<StatsResult> {
    const days = STATS_RANGES[range];
    const since = new Date(now.getTime() - days * DAY_MS);
    const activeSince = new Date(now.getTime() - 7 * DAY_MS);

    const [
      totalUsers,
      newUsers,
      activeUsers,
      docsByDay,
      confidence,
      needsReview,
      ackRows,
      emergencyRows,
      costByDay,
      budget,
      demo,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: since } } }),
      this.prisma.user.count({ where: { deletedAt: null, lastInboundAt: { gte: activeSince } } }),
      this.prisma.$queryRaw<{ day: string; kind: string; n: number }[]>(Prisma.sql`
        SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
               kind::text AS kind, count(*)::int AS n
        FROM documents WHERE created_at >= ${since} GROUP BY 1, 2 ORDER BY 1`),
      this.prisma.document.aggregate({
        _avg: { overallConfidence: true },
        where: { createdAt: { gte: since }, status: { in: ['done', 'needs_review'] } },
      }),
      this.prisma.document.count({ where: { status: 'needs_review', reviewedAt: null } }),
      this.prisma.$queryRaw<{ status: string; n: number }[]>(Prisma.sql`
        SELECT status::text AS status, count(*)::int AS n FROM reminders
        WHERE scheduled_at >= ${since} AND status IN ('taken', 'missed', 'skipped') GROUP BY 1`),
      this.prisma.$queryRaw<{ category: string; n: number }[]>(Prisma.sql`
        SELECT coalesce(metadata->>'category', 'unknown') AS category, count(*)::int AS n
        FROM audit_logs WHERE action = 'emergency_detected' AND created_at >= ${since} GROUP BY 1 ORDER BY 2 DESC`),
      this.budget.costSeries(Math.min(days, 30)),
      this.budget.snapshot(),
      this.budget.demoSnapshot(),
    ]);

    const ack = Object.fromEntries(ackRows.map((row) => [row.status, row.n])) as Record<
      string,
      number
    >;
    const answered = (ack.taken ?? 0) + (ack.missed ?? 0) + (ack.skipped ?? 0);
    return {
      range,
      users: { total: totalUsers, new: newUsers, active7d: activeUsers },
      documentsByDay: docsByDay,
      averageConfidence:
        confidence._avg.overallConfidence === null
          ? null
          : Number(confidence._avg.overallConfidence),
      needsReview,
      reminders: {
        taken: ack.taken ?? 0,
        missed: ack.missed ?? 0,
        skipped: ack.skipped ?? 0,
        ackRate: answered === 0 ? null : (ack.taken ?? 0) / answered,
      },
      emergenciesByCategory: emergencyRows,
      costByDay,
      budget: {
        state: budget.state,
        spentUsd: budget.spentUsd,
        ratio: budget.ratio,
        demoExhausted: demo.exhausted,
        demoSpentUsd: demo.spentUsd,
      },
    };
  }

  // ------------------------------------------------------------------ review queue

  async reviewQueue(options: {
    limit: number;
    cursor?: string;
    includeReviewed: boolean;
  }): Promise<ReviewQueuePage> {
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (options.cursor && !cursor) throw new AdminError('invalid_request', HttpStatus.BAD_REQUEST);

    const where: Prisma.DocumentWhereInput = {
      AND: [
        {
          OR: [
            { status: 'needs_review' },
            { status: 'done', overallConfidence: { lt: REVIEW_CONFIDENCE_BELOW } },
          ],
        },
        options.includeReviewed ? {} : { reviewedAt: null },
        cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {},
      ],
    };
    const rows = await this.prisma.document.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
      // The extraction is read only to COUNT unclear items; it never leaves this method.
      select: {
        id: true,
        userId: true,
        kind: true,
        status: true,
        createdAt: true,
        overallConfidence: true,
        promptVersion: true,
        model: true,
        reviewLabel: true,
        reviewedAt: true,
        extraction: true,
      },
    });
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        userId: row.userId,
        kind: row.kind,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        confidence: row.overallConfidence === null ? null : Number(row.overallConfidence),
        promptVersion: row.promptVersion,
        model: row.model,
        warnings: reviewSignals(row.extraction),
        reviewLabel: row.reviewLabel,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length > options.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** PHI access. The audit row is written FIRST: if it cannot be written, nothing is revealed. */
  async reveal(id: string, adminEmail: string, reason: string): Promise<RevealResult> {
    if (reason.trim().length < MIN_REASON_CHARS) {
      throw new AdminError('reason_required', HttpStatus.BAD_REQUEST);
    }
    const document = await this.prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        kind: true,
        status: true,
        createdAt: true,
        s3Key: true,
        extraction: true,
        overallConfidence: true,
        promptVersion: true,
      },
    });
    if (!document) throw new AdminError('not_found', HttpStatus.NOT_FOUND);
    await this.audit.logAdmin({
      action: 'admin_reveal',
      adminEmail,
      userId: document.userId,
      metadata: { document_id: document.id, kind: document.kind },
      reason,
    });
    const imageUrl = await this.storage.getPresignedUrl(document.s3Key, REVEAL_URL_TTL_S);
    return {
      id: document.id,
      kind: document.kind,
      status: document.status,
      createdAt: document.createdAt.toISOString(),
      confidence: document.overallConfidence === null ? null : Number(document.overallConfidence),
      promptVersion: document.promptVersion,
      extraction: document.extraction,
      imageUrl,
      imageExpiresInS: REVEAL_URL_TTL_S,
    };
  }

  async resolve(
    id: string,
    adminEmail: string,
    label: ReviewLabelName,
  ): Promise<{ id: string; label: ReviewLabelName }> {
    const updated = await this.prisma.document.updateMany({
      where: { id },
      data: {
        reviewLabel: label,
        reviewedAt: new Date(),
        reviewedByHash: createHash('sha256').update(adminEmail).digest('hex'),
      },
    });
    if (updated.count === 0) throw new AdminError('not_found', HttpStatus.NOT_FOUND);
    await this.audit.logAdmin({
      action: 'admin_review_resolved',
      adminEmail,
      metadata: { document_id: id, label },
    });
    return { id, label };
  }

  // ------------------------------------------------------------------ dead letters

  async dlqOverview(): Promise<DlqOverview> {
    const queues = await Promise.all(
      DLQ_SOURCE_QUEUES.map(async (queue) => {
        const listing = await this.dlq.list(queue, 25);
        return { queue, size: listing.size, entries: listing.entries };
      }),
    );
    return { queues };
  }

  async dlqRetry(
    queueName: string,
    jobId: string,
    adminEmail: string,
  ): Promise<{ retried: number; missing: number }> {
    let queue;
    try {
      queue = assertSourceQueue(queueName);
    } catch {
      throw new AdminError('invalid_request', HttpStatus.BAD_REQUEST);
    }
    if (jobId.length === 0 || jobId.length > 200) {
      throw new AdminError('invalid_request', HttpStatus.BAD_REQUEST);
    }
    const result = await this.dlq.retry(queue, { jobId });
    await this.audit.logAdmin({
      action: 'admin_dlq_retry',
      adminEmail,
      // Job ids can be WhatsApp message ids: only a short hash goes into the audit row.
      metadata: {
        queue,
        job_ref: hashRef(jobId),
        retried: result.retried,
        missing: result.missing,
      },
    });
    return result;
  }
}
