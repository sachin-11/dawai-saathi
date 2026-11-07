import { randomBytes } from 'node:crypto';

import type { PinoLogger } from 'nestjs-pino';

import { CryptoService } from '../common/crypto/crypto.service';
import type { PendingStore } from '../common/pending/pending.store';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { StorageService } from '../common/storage/storage.service';
import type { Env } from '../config/env.schema';
import { I18nService } from '../messaging/i18n/i18n.service';
import type { WhatsAppClient } from '../messaging/whatsapp.client';
import { WhatsAppApiError } from '../messaging/whatsapp.errors';
import type { QueueCleanupService } from './queue-cleanup.service';
import type { UserDeletionJobData } from './user-deletion.queue';
import { UserDeletionService, type DeletionJobLike } from './user-deletion.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PHONE = '919876501234';
const crypto = new CryptoService({
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PHONE_HASH_PEPPER: 'pepper-for-tests',
} as Env);
const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as PinoLogger;
const i18n = new I18nService({
  setContext: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as PinoLogger);

const COUNTS = {
  messages: 7,
  documents: 2,
  medications: 3,
  reminders: 5,
  caregivers: 1,
  audit_logs: 4,
};

interface Setup {
  service: UserDeletionService;
  calls: string[];
  storage: { deletePrefix: jest.Mock };
  cleanup: { removeAllFor: jest.Mock };
  pending: { clearAllFor: jest.Mock };
  client: { sendText: jest.Mock };
  tx: {
    user: { findUnique: jest.Mock; delete: jest.Mock };
    message: { count: jest.Mock };
    document: { count: jest.Mock };
    medication: { count: jest.Mock };
    reminder: { count: jest.Mock };
    caregiver: { count: jest.Mock };
    auditLog: { count: jest.Mock; deleteMany: jest.Mock; create: jest.Mock };
  };
  userExists: { value: boolean };
}

function setup(): Setup {
  const calls: string[] = [];
  const track = (name: string, value?: unknown): jest.Mock =>
    jest.fn().mockImplementation(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  const userExists = { value: true };
  const tx = {
    user: {
      findUnique: jest.fn().mockImplementation(() => {
        calls.push('tx.findUser');
        return Promise.resolve(userExists.value ? { id: USER_ID } : null);
      }),
      delete: jest.fn().mockImplementation(() => {
        calls.push('tx.deleteUser');
        userExists.value = false;
        return Promise.resolve({});
      }),
    },
    message: { count: jest.fn().mockResolvedValue(COUNTS.messages) },
    document: { count: jest.fn().mockResolvedValue(COUNTS.documents) },
    medication: { count: jest.fn().mockResolvedValue(COUNTS.medications) },
    reminder: { count: jest.fn().mockResolvedValue(COUNTS.reminders) },
    caregiver: { count: jest.fn().mockResolvedValue(COUNTS.caregivers) },
    auditLog: {
      count: jest.fn().mockResolvedValue(COUNTS.audit_logs),
      deleteMany: track('tx.deleteAuditRows'),
      create: track('tx.createAudit'),
    },
  };
  const prisma = {
    $transaction: jest
      .fn()
      .mockImplementation(async (callback: (t: unknown) => Promise<unknown>) => {
        calls.push('tx.begin');
        const result = await callback(tx);
        calls.push('tx.commit');
        return result;
      }),
  };
  const storage = { deletePrefix: track('s3.deletePrefix', 3) };
  const cleanup = { removeAllFor: track('queues.removeAllFor', 2) };
  const pending = { clearAllFor: track('pending.clearAllFor', 1) };
  const client = { sendText: track('client.sendText', { waMessageId: 'wamid.X' }) };
  const service = new UserDeletionService(
    prisma as unknown as PrismaService,
    crypto,
    storage as unknown as StorageService,
    cleanup as unknown as QueueCleanupService,
    pending as unknown as PendingStore,
    client as unknown as WhatsAppClient,
    i18n,
    logger,
  );
  return { service, calls, storage, cleanup, pending, client, tx, userExists };
}

function jobWith(
  extra: Partial<UserDeletionJobData> = {},
): DeletionJobLike & { updateData: jest.Mock } {
  const job: DeletionJobLike & { updateData: jest.Mock } = {
    data: {
      userId: USER_ID,
      waPhoneEnc: crypto.encrypt(PHONE),
      language: 'hi',
      requestId: 'req-1',
      ...extra,
    },
    updateData: jest.fn().mockImplementation((data: UserDeletionJobData) => {
      job.data = data;
      return Promise.resolve();
    }),
  };
  return job;
}

describe('UserDeletionService.execute', () => {
  it('runs the steps in the required order: S3, queues, pending keys, database, final message', async () => {
    const s = setup();
    await s.service.execute(jobWith());
    expect(s.calls).toEqual([
      's3.deletePrefix',
      'queues.removeAllFor',
      'pending.clearAllFor',
      'tx.begin',
      'tx.findUser',
      'tx.deleteAuditRows',
      'tx.deleteUser',
      'tx.createAudit',
      'tx.commit',
      'client.sendText',
    ]);
  });

  it("deletes only this user's media prefix, with a trailing slash", async () => {
    const s = setup();
    await s.service.execute(jobWith());
    expect(s.storage.deletePrefix).toHaveBeenCalledWith(`media/${USER_ID}/`);
    expect(s.cleanup.removeAllFor).toHaveBeenCalledWith(USER_ID);
    expect(s.pending.clearAllFor).toHaveBeenCalledWith(USER_ID);
  });

  it("deletes the user, the user's audit rows, and writes ONE anonymous user_deleted row (no phone, no hash)", async () => {
    const s = setup();
    await s.service.execute(jobWith());

    expect(s.tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
    expect(s.tx.auditLog.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(s.tx.auditLog.create).toHaveBeenCalledTimes(1);
    const created = (s.tx.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> })
      .data;
    expect(created).toMatchObject({ actor: 'user', userId: null, action: 'user_deleted' });
    expect(created['metadata']).toEqual({
      s3_objects_deleted: 3,
      queue_jobs_removed: 2,
      rows_deleted_by_table: { users: 1, ...COUNTS },
    });

    const serialised = JSON.stringify(created);
    expect(serialised).not.toContain(PHONE);
    expect(serialised).not.toContain(USER_ID);
    expect(serialised).not.toMatch(/hash|phone/i);
  });

  it("sends the final message ONCE, directly through the WhatsApp client, in the user's language", async () => {
    const s = setup();
    const job = jobWith({ language: 'hi' });
    const result = await s.service.execute(job);

    expect(s.client.sendText).toHaveBeenCalledTimes(1);
    const [to, text, options] = s.client.sendText.mock.calls[0] as [
      string,
      string,
      { requestId: string },
    ];
    expect(to).toBe(PHONE); // decrypted only in memory
    expect(text).toBe(i18n.t('hi', 'delete.done'));
    expect(options).toEqual({ requestId: 'req-1' });
    expect(result.finalMessageSent).toBe(true);
    expect(job.data.finalMessageSent).toBe(true);
  });

  it('does not touch the outbound queue or persist the final message (the user row is gone)', async () => {
    const s = setup();
    await s.service.execute(jobWith());
    // the only collaborators are the client and the database transaction: no message insert anywhere
    expect(s.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  describe('idempotency (a crash can happen between any two steps)', () => {
    it('running the whole job twice deletes once, audits once and sends the final message once', async () => {
      const s = setup();
      const job = jobWith();
      await s.service.execute(job);
      const second = await s.service.execute(job);

      expect(s.tx.user.delete).toHaveBeenCalledTimes(1);
      expect(s.tx.auditLog.create).toHaveBeenCalledTimes(1);
      expect(s.client.sendText).toHaveBeenCalledTimes(1);
      expect(second.rowsDeleted).toBeNull();
      expect(second.finalMessageSent).toBe(true);
    });

    it('a retry after the database step but before the final message still sends it (phone kept in the job)', async () => {
      const s = setup();
      s.client.sendText.mockRejectedValueOnce(
        new WhatsAppApiError({ httpStatus: 503, kind: 'server', retryable: true, message: 'x' }),
      );
      const job = jobWith();
      await expect(s.service.execute(job)).rejects.toBeInstanceOf(WhatsAppApiError);
      expect(s.userExists.value).toBe(false); // the data IS already gone

      const retry = await s.service.execute(job);
      expect(retry.finalMessageSent).toBe(true);
      expect(s.client.sendText).toHaveBeenCalledTimes(2); // failed attempt + successful retry
      expect(s.tx.auditLog.create).toHaveBeenCalledTimes(1); // still ONE audit row
    });

    it('a retry after an S3 failure repeats the earlier steps harmlessly', async () => {
      const s = setup();
      s.storage.deletePrefix.mockRejectedValueOnce(new Error('S3 unavailable'));
      const job = jobWith();
      await expect(s.service.execute(job)).rejects.toThrow('S3 unavailable');
      expect(s.tx.user.delete).not.toHaveBeenCalled(); // never deletes the user before S3 is clean

      await expect(s.service.execute(job)).resolves.toMatchObject({ s3ObjectsDeleted: 3 });
      expect(s.tx.user.delete).toHaveBeenCalledTimes(1);
    });

    it('accumulates the S3 / queue totals in the job data so the audit row reports the real numbers', async () => {
      const s = setup();
      const job = jobWith({ s3ObjectsDeleted: 10, queueJobsRemoved: 4 });
      await s.service.execute(job);
      const created = (
        s.tx.auditLog.create.mock.calls[0]?.[0] as { data: { metadata: Record<string, unknown> } }
      ).data;
      expect(created.metadata).toMatchObject({ s3_objects_deleted: 13, queue_jobs_removed: 6 });
    });
  });

  describe('final message edge cases', () => {
    it('does not fail (or retry) when the user cannot receive it (e.g. blocked us): the data is deleted', async () => {
      const s = setup();
      s.client.sendText.mockRejectedValue(
        new WhatsAppApiError({
          httpStatus: 400,
          kind: 'undeliverable',
          retryable: false,
          code: 131026,
          message: 'x',
        }),
      );
      const result = await s.service.execute(jobWith());
      expect(result.finalMessageSent).toBe(false);
      expect(s.tx.user.delete).toHaveBeenCalledTimes(1);
    });

    it('erases without a final message if the phone number cannot be decrypted', async () => {
      const s = setup();
      const result = await s.service.execute(jobWith({ waPhoneEnc: 'v1:garbage:garbage:garbage' }));
      expect(s.client.sendText).not.toHaveBeenCalled();
      expect(result.rowsDeleted).not.toBeNull();
    });

    it('erases without a final message if no phone was stored in the job', async () => {
      const s = setup();
      await s.service.execute(jobWith({ waPhoneEnc: null }));
      expect(s.client.sendText).not.toHaveBeenCalled();
      expect(s.tx.user.delete).toHaveBeenCalledTimes(1);
    });
  });
});
