import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { assertSafeAuditMetadata } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PendingStore } from '../common/pending/pending.store';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { I18nService } from '../messaging/i18n/i18n.service';
import { WhatsAppClient } from '../messaging/whatsapp.client';
import { WhatsAppApiError } from '../messaging/whatsapp.errors';
import { QueueCleanupService } from './queue-cleanup.service';
import type { UserDeletionJobData } from './user-deletion.queue';

/** The part of a BullMQ job `execute` needs (keeps it testable without Redis). */
export interface DeletionJobLike {
  data: UserDeletionJobData;
  updateData(data: UserDeletionJobData): Promise<void>;
}

export type RowCounts = Record<
  'users' | 'messages' | 'documents' | 'medications' | 'reminders' | 'caregivers' | 'audit_logs',
  number
>;

export interface DeletionResult {
  s3ObjectsDeleted: number;
  queueJobsRemoved: number;
  pendingKeysRemoved: number;
  /** Null when the user row was already gone (a retry). */
  rowsDeleted: RowCounts | null;
  finalMessageSent: boolean;
}

/**
 * Right-to-erasure job (DPDP Act, CLAUDE.md §6): hard-deletes EVERYTHING about a user.
 *
 * Order matters and every step is safe to run again (a crash can happen between any two):
 *   1. read the phone number into memory (needed only for the last message)
 *   2. S3: delete every object under `media/<userId>/`
 *   3. Redis: remove the user's inbound/outbound jobs (incl. completed ones that hold encrypted text)
 *   4. Redis: remove `pending:*:<userId>` keys
 *   5. ONE database transaction: delete the user (cascades to caregivers, messages, documents,
 *      medications, reminders), delete the user's audit rows, and write one ANONYMOUS
 *      `user_deleted` audit row. The transaction makes "user gone" and "audit row exists" one event.
 *   6. send the final confirmation straight through the WhatsApp client (not the outbound queue:
 *      the user row it would need is gone) and do not store it.
 */
@Injectable()
export class UserDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly cleanup: QueueCleanupService,
    private readonly pending: PendingStore,
    private readonly client: WhatsAppClient,
    private readonly i18n: I18nService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(UserDeletionService.name);
  }

  async execute(job: DeletionJobLike): Promise<DeletionResult> {
    const { userId } = job.data;

    // 1. phone number, in memory only
    const phone = this.readPhone(job.data.waPhoneEnc);

    // 2. S3. Counts are accumulated in the job data so a retry still reports the real total.
    const s3Now = await this.storage.deletePrefix(`media/${userId}/`);
    const s3ObjectsDeleted = (job.data.s3ObjectsDeleted ?? 0) + s3Now;

    // 3. + 4. Redis
    const jobsNow = await this.cleanup.removeAllFor(userId);
    const queueJobsRemoved = (job.data.queueJobsRemoved ?? 0) + jobsNow;
    const pendingKeysRemoved = await this.pending.clearAllFor(userId);
    if (s3Now > 0 || jobsNow > 0) {
      await job.updateData({ ...job.data, s3ObjectsDeleted, queueJobsRemoved });
    }

    // 5. database
    const rowsDeleted = await this.deleteFromDatabase(userId, s3ObjectsDeleted, queueJobsRemoved);

    // 6. final message
    let finalMessageSent = job.data.finalMessageSent === true;
    if (!finalMessageSent && phone) {
      finalMessageSent = await this.sendFinalMessage(job, phone);
    }

    this.logger.info(
      {
        s3_objects_deleted: s3ObjectsDeleted,
        queue_jobs_removed: queueJobsRemoved,
        user_row_deleted_now: rowsDeleted !== null,
        final_message_sent: finalMessageSent,
        request_id: job.data.requestId,
      },
      'user erasure finished',
    );
    return {
      s3ObjectsDeleted,
      queueJobsRemoved,
      pendingKeysRemoved,
      rowsDeleted,
      finalMessageSent,
    };
  }

  private readPhone(waPhoneEnc: string | null): string | undefined {
    if (!waPhoneEnc) return undefined;
    try {
      return this.crypto.decrypt(waPhoneEnc);
    } catch {
      this.logger.warn('could not decrypt the phone number: erasing without a final message');
      return undefined;
    }
  }

  /** Returns the per-table row counts, or null if the user was already deleted (idempotent retry). */
  private deleteFromDatabase(
    userId: string,
    s3ObjectsDeleted: number,
    queueJobsRemoved: number,
  ): Promise<RowCounts | null> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) {
        return null;
      }

      // Count BEFORE deleting: the cascade removes the child rows with the user.
      const rows: RowCounts = {
        users: 1,
        messages: await tx.message.count({ where: { userId } }),
        documents: await tx.document.count({ where: { userId } }),
        medications: await tx.medication.count({ where: { userId } }),
        reminders: await tx.reminder.count({ where: { userId } }),
        caregivers: await tx.caregiver.count({ where: { userId } }),
        audit_logs: await tx.auditLog.count({ where: { userId } }),
      };

      // audit_logs has no foreign key on purpose; only the anonymous record below may remain.
      await tx.auditLog.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });

      const metadata = {
        s3_objects_deleted: s3ObjectsDeleted,
        queue_jobs_removed: queueJobsRemoved,
        rows_deleted_by_table: rows,
      };
      assertSafeAuditMetadata(metadata);
      await tx.auditLog.create({
        data: {
          actor: 'user',
          userId: null, // anonymous: no user id, no phone, no hash
          action: 'user_deleted',
          metadata,
        },
      });
      return rows;
    });
  }

  private async sendFinalMessage(job: DeletionJobLike, phone: string): Promise<boolean> {
    try {
      await this.client.sendText(phone, this.i18n.t(job.data.language, 'delete.done'), {
        requestId: job.data.requestId,
      });
    } catch (error) {
      if (error instanceof WhatsAppApiError && !error.retryable) {
        // e.g. the user blocked us: the data IS deleted, so do not fail (and retry) the whole job.
        this.logger.warn({ kind: error.kind, code: error.code }, 'final message not deliverable');
        return false;
      }
      throw error; // transient: retry the job, every earlier step is a no-op by now
    }
    await job.updateData({ ...job.data, finalMessageSent: true });
    return true;
  }
}
