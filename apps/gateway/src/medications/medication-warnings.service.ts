import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { InteractionFinding, InteractionReport } from '../ai-client/types';
import { PrismaService } from '../common/prisma/prisma.service';

type Client = Prisma.TransactionClient | PrismaService;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEW_REF = /^rx:(\d{1,3})$/;

export type WarningType = 'interaction' | 'duplicate_ingredient';

/** A stored warning with the medicine names it involves (names as the user knows them). */
export interface ActiveWarning {
  id: string;
  type: WarningType;
  saltA: string;
  saltB: string;
  severity: 'minor' | 'moderate' | 'major' | null;
  medicationIds: string[];
  labels: string[];
}

export interface RecordStats {
  created: number;
  updated: number;
  resolved: number;
}

/**
 * A reference from the AI service -> the id of a stored medication. `rx:<i>` is the i-th medicine of
 * the prescription just saved; anything else must be the id of a medication we sent as context.
 */
export function refToMedicationId(ref: string, savedIds: readonly string[]): string | null {
  const fresh = NEW_REF.exec(ref);
  if (fresh) return savedIds[Number(fresh[1])] ?? null;
  return UUID.test(ref) ? ref : null;
}

function keyOf(type: string, saltA: string, saltB: string): string {
  return `${type}|${saltA}|${saltB}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * The user's interaction / duplicate-ingredient warnings (M11). A warning is stored once while it is
 * active (partial unique index on `(user_id, type, salt_a, salt_b)`), so listing it later or checking
 * again never repeats it. Warnings contain salts and medication ids only: no free text, no PHI.
 */
@Injectable()
export class MedicationWarningsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Store the findings of a NEW prescription, inside the caller's transaction (so "document saved"
   * and "warnings saved" are one event). An existing active warning for the same pair only grows its
   * list of medicines. Returns counts for the log.
   */
  async recordFindings(
    client: Client,
    userId: string,
    report: InteractionReport | null | undefined,
    savedMedicationIds: readonly string[],
  ): Promise<RecordStats> {
    const stats: RecordStats = { created: 0, updated: 0, resolved: 0 };
    const findings = report?.findings ?? [];
    if (!report || !report.database_ok || findings.length === 0) return stats;
    return this.upsert(client, userId, findings, savedMedicationIds, stats);
  }

  /**
   * CHECK: the report covers ALL active medicines, so the stored active set becomes exactly the
   * findings: new ones are added, ones that no longer apply are resolved. A report from a failing
   * database changes nothing.
   */
  async syncAll(userId: string, report: InteractionReport): Promise<RecordStats> {
    const stats: RecordStats = { created: 0, updated: 0, resolved: 0 };
    if (!report.database_ok) return stats;
    return this.prisma.$transaction(async (tx) => {
      const findings = report.findings ?? [];
      await this.upsert(tx, userId, findings, [], stats);
      const found = new Set(findings.map((f) => keyOf(f.type, f.salt_a, f.salt_b)));
      const active = await tx.medicationWarning.findMany({
        where: { userId, status: 'active' },
        select: { id: true, type: true, saltA: true, saltB: true },
      });
      const stale = active.filter((w) => !found.has(keyOf(w.type, w.saltA, w.saltB)));
      if (stale.length > 0) {
        await tx.medicationWarning.updateMany({
          where: { id: { in: stale.map((w) => w.id) } },
          data: { status: 'resolved' },
        });
        stats.resolved += stale.length;
      }
      return stats;
    });
  }

  private async upsert(
    client: Client,
    userId: string,
    findings: readonly InteractionFinding[],
    savedIds: readonly string[],
    stats: RecordStats,
  ): Promise<RecordStats> {
    const existing = await client.medicationWarning.findMany({
      where: { userId, status: 'active' },
      select: { id: true, type: true, saltA: true, saltB: true, medicationIds: true },
    });
    const byKey = new Map(existing.map((w) => [keyOf(w.type, w.saltA, w.saltB), w]));
    const toCreate: Prisma.MedicationWarningCreateManyInput[] = [];
    for (const finding of findings) {
      const ids = unique(
        (finding.medication_refs ?? []).flatMap((ref) => {
          const id = refToMedicationId(ref, savedIds);
          return id ? [id] : [];
        }),
      );
      if (ids.length < 2 && finding.type === 'duplicate_ingredient') continue; // needs two products
      if (ids.length === 0) continue;
      const current = byKey.get(keyOf(finding.type, finding.salt_a, finding.salt_b));
      if (current) {
        const merged = unique([...current.medicationIds, ...ids]);
        if (merged.length !== current.medicationIds.length) {
          await client.medicationWarning.update({
            where: { id: current.id },
            data: { medicationIds: merged },
          });
          stats.updated += 1;
        }
        continue;
      }
      toCreate.push({
        userId,
        type: finding.type,
        medicationIds: ids,
        saltA: finding.salt_a,
        saltB: finding.salt_b,
        severity: finding.severity ?? null,
        interactionId:
          finding.interaction_id && UUID.test(finding.interaction_id)
            ? finding.interaction_id
            : null,
      });
    }
    if (toCreate.length > 0) {
      // ON CONFLICT DO NOTHING: a concurrent worker inserting the same active pair is not an error.
      const result = await client.medicationWarning.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      stats.created += result.count;
    }
    return stats;
  }

  /**
   * Medicines were switched off (Something is wrong, course ended): drop them from their warnings.
   * A warning left with fewer than two medicines no longer describes a combination: it is resolved.
   */
  async resolveForMedications(
    client: Client,
    userId: string,
    medicationIds: readonly string[],
  ): Promise<number> {
    if (medicationIds.length === 0) return 0;
    const affected = await client.medicationWarning.findMany({
      where: { userId, status: 'active', medicationIds: { hasSome: [...medicationIds] } },
      select: { id: true, medicationIds: true },
    });
    const gone = new Set(medicationIds);
    let resolved = 0;
    for (const warning of affected) {
      const remaining = warning.medicationIds.filter((id) => !gone.has(id));
      if (remaining.length < 2) {
        await client.medicationWarning.update({
          where: { id: warning.id },
          data: { status: 'resolved', medicationIds: remaining },
        });
        resolved += 1;
      } else {
        await client.medicationWarning.update({
          where: { id: warning.id },
          data: { medicationIds: remaining },
        });
      }
    }
    return resolved;
  }

  /** Active warnings of the user, optionally only those involving the given medicines. */
  async listActive(
    userId: string,
    onlyMedicationIds?: readonly string[],
  ): Promise<ActiveWarning[]> {
    const rows = await this.prisma.medicationWarning.findMany({
      where: {
        userId,
        status: 'active',
        ...(onlyMedicationIds ? { medicationIds: { hasSome: [...onlyMedicationIds] } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    const ids = unique(rows.flatMap((row) => row.medicationIds));
    const names = new Map(
      (
        await this.prisma.medication.findMany({
          where: { userId, id: { in: ids } },
          select: { id: true, rawName: true },
        })
      ).map((m) => [m.id, m.rawName]),
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      saltA: row.saltA,
      saltB: row.saltB,
      severity: row.severity,
      medicationIds: row.medicationIds,
      labels: row.medicationIds.flatMap((id) => {
        const name = names.get(id);
        return name ? [name] : [];
      }),
    }));
  }

  /** Ids of the medicines that are part of at least one active warning (the MEDS marker). */
  async medicationIdsWithWarnings(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.medicationWarning.findMany({
      where: { userId, status: 'active' },
      select: { medicationIds: true },
    });
    return new Set(rows.flatMap((row) => row.medicationIds));
  }
}
