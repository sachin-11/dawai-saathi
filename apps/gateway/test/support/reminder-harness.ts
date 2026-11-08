/**
 * Test harness for M10: the REAL reminder services on a REAL Postgres, with an in-memory BullMQ
 * stand-in (delayed jobs, deterministic ids, "already added" dedupe) and a recording outbound sender.
 * Time is a parameter everywhere, so a test can "travel" through days in 5-minute steps.
 */
import { randomUUID } from 'node:crypto';

import type { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../../src/audit/audit.service';
import { CaregiversService } from '../../src/caregivers/caregivers.service';
import { CryptoService } from '../../src/common/crypto/crypto.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import type { RedisService } from '../../src/common/redis/redis.service';
import { type Env, validateEnv } from '../../src/config/env.schema';
import type { ReplySession } from '../../src/conversation/replies.service';
import { I18nService } from '../../src/messaging/i18n/i18n.service';
import type { OutboundService } from '../../src/messaging/outbound.service';
import type { OutboundRequest } from '../../src/messaging/outbound.types';
import { ReminderAckService } from '../../src/reminders/reminder-ack.service';
import { ReminderDispatchService } from '../../src/reminders/reminder-dispatch.service';
import { ReminderMessages } from '../../src/reminders/reminder-messages';
import { ReminderPlannerService } from '../../src/reminders/reminder-planner.service';
import { ReminderScheduleService } from '../../src/reminders/reminder-schedule.service';
import {
  type CaregiverReplyJobData,
  jobIds,
  type ReminderJobData,
  type ReminderQueue,
} from '../../src/reminders/reminder.queue';
import { ReminderWorker } from '../../src/reminders/reminder.worker';
import { epochSeconds } from '../../src/reminders/clock';
import { INTEGRATION_ENV, prepareTestDatabase } from './integration-env';

export interface FakeJob {
  id: string;
  name: string;
  data: ReminderJobData;
  runAt: Date;
}

/** Same observable rules as the real queue: deterministic ids, adding an existing id is a no-op. */
export class FakeReminderQueue {
  readonly jobs = new Map<string, FakeJob>();
  private readonly everAdded = new Set<string>();
  addCalls = 0;

  private put(
    name: string,
    data: ReminderJobData,
    id: string,
    runAt: Date | null,
    now: Date,
  ): void {
    this.addCalls += 1;
    if (this.everAdded.has(id)) return;
    this.everAdded.add(id);
    this.jobs.set(id, { id, name, data, runAt: runAt ?? now });
  }

  addSlot(userId: string, at: Date, now: Date = new Date()): Promise<void> {
    this.put('slot', { userId, scheduledAt: at.toISOString() }, jobIds.slot(userId, at), at, now);
    return Promise.resolve();
  }
  addMissed(
    userId: string,
    at: Date,
    runAt: Date,
    round = 0,
    now: Date = new Date(),
  ): Promise<void> {
    this.put(
      'missed',
      { userId, scheduledAt: at.toISOString() },
      jobIds.missed(userId, at, round),
      runAt,
      now,
    );
    return Promise.resolve();
  }
  addSnooze(
    userId: string,
    at: Date,
    attempt: number,
    runAt: Date,
    now: Date = new Date(),
  ): Promise<void> {
    this.put(
      'snooze',
      { userId, scheduledAt: at.toISOString(), attempt },
      jobIds.snooze(userId, at, attempt),
      runAt,
      now,
    );
    return Promise.resolve();
  }
  addAlert(userId: string, at: Date, now: Date = new Date()): Promise<void> {
    this.put(
      'alert',
      { userId, scheduledAt: at.toISOString() },
      jobIds.alert(userId, at),
      null,
      now,
    );
    return Promise.resolve();
  }
  addCaregiverReply(data: CaregiverReplyJobData, now: Date = new Date()): Promise<void> {
    this.put(
      'caregiver_reply',
      data,
      jobIds.caregiverReply(data.waMessageId, data.caregiverId),
      null,
      now,
    );
    return Promise.resolve();
  }
  removeSlotJobs(userId: string, slots: readonly Date[]): Promise<number> {
    let removed = 0;
    for (const slot of slots) {
      for (const id of [
        jobIds.slot(userId, slot),
        jobIds.missed(userId, slot),
        jobIds.missed(userId, slot, 1),
        jobIds.missed(userId, slot, 2),
        jobIds.snooze(userId, slot, 1),
        jobIds.snooze(userId, slot, 2),
      ]) {
        // Like BullMQ: a removed job is gone, so the same id can be added again later.
        this.everAdded.delete(id);
        if (this.jobs.delete(id)) removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  /** Waiting/delayed jobs that belong to a user (what a DELETE or STOP must leave empty). */
  forUser(userId: string): FakeJob[] {
    return [...this.jobs.values()].filter(
      (job) => (job.data as { userId?: string }).userId === userId,
    );
  }

  /** Remove and return the jobs due at `now`, oldest first. */
  takeDue(now: Date): FakeJob[] {
    const due = [...this.jobs.values()]
      .filter((job) => job.runAt.getTime() <= now.getTime())
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
    for (const job of due) this.jobs.delete(job.id);
    return due;
  }
}

export interface SentRequest {
  userId: string;
  request: OutboundRequest;
  at: Date;
}

export class FakeOutbound {
  readonly sent: SentRequest[] = [];
  private readonly seen = new Set<string>();
  clock: Date = new Date();

  enqueue(userId: string, request: OutboundRequest): Promise<void> {
    const key = `${request.sourceMessageId}_${request.replyIndex}`;
    if (this.seen.has(key)) return Promise.resolve(); // same job id: the real queue ignores it
    this.seen.add(key);
    this.sent.push({ userId, request, at: this.clock });
    return Promise.resolve();
  }

  reminders(userId: string): SentRequest[] {
    return this.sent.filter(
      (item) => item.userId === userId && item.request.sourceMessageId.startsWith('rem_'),
    );
  }
  toCaregivers(userId: string): SentRequest[] {
    return this.sent.filter(
      (item) => item.userId === userId && item.request.recipient !== undefined,
    );
  }
}

const logger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as PinoLogger;

export interface Harness {
  env: Env;
  prisma: PrismaService;
  crypto: CryptoService;
  queue: FakeReminderQueue;
  outbound: FakeOutbound;
  planner: ReminderPlannerService;
  schedules: ReminderScheduleService;
  dispatch: ReminderDispatchService;
  acks: ReminderAckService;
  caregivers: CaregiversService;
  worker: ReminderWorker;
  /** Run every job that is due at `now` (jobs may add new due jobs). */
  runDue(now: Date): Promise<string[]>;
  close(): Promise<void>;
}

export function createHarness(overrides: Record<string, string> = {}): Harness {
  const env = validateEnv({ ...INTEGRATION_ENV, ...overrides });
  prepareTestDatabase(env.DATABASE_URL);
  const prisma = new PrismaService(env);
  const crypto = new CryptoService(env);
  const queue = new FakeReminderQueue();
  const outbound = new FakeOutbound();
  const i18n = new I18nService(logger);
  const audit = new AuditService(prisma);
  const asQueue = queue as unknown as ReminderQueue;
  const asOutbound = outbound as unknown as OutboundService;

  const planner = new ReminderPlannerService(prisma, asQueue, asOutbound, i18n, env, logger);
  const schedules = new ReminderScheduleService(prisma, planner, asQueue, audit, env, logger);
  const dispatch = new ReminderDispatchService(
    prisma,
    asOutbound,
    asQueue,
    new ReminderMessages(i18n),
    env,
    logger,
  );
  const acks = new ReminderAckService(prisma, asQueue, env);
  const caregivers = new CaregiversService(prisma, crypto, asOutbound, i18n, audit, logger);
  const worker = new ReminderWorker(
    {} as unknown as RedisService,
    asQueue,
    dispatch,
    planner,
    caregivers,
    env,
    logger,
  );

  return {
    env,
    prisma,
    crypto,
    queue,
    outbound,
    planner,
    schedules,
    dispatch,
    acks,
    caregivers,
    worker,
    async runDue(now: Date): Promise<string[]> {
      outbound.clock = now;
      const results: string[] = [];
      for (let round = 0; round < 20; round += 1) {
        const due = queue.takeDue(now);
        if (due.length === 0) break;
        for (const job of due) {
          results.push(`${job.name}:${await worker.process(job, now)}`);
        }
      }
      return results;
    },
    async close(): Promise<void> {
      await prisma.onModuleDestroy();
    },
  };
}

export interface TestPrescription {
  userId: string;
  documentId: string;
  medicationIds: string[];
}

/** An onboarded user with a prescription: two daily medicines, one SOS medicine, one unclear one. */
export async function createUserWithPrescription(
  prisma: PrismaService,
  options: {
    startDate: string;
    durationDays: number | null;
    lastInboundAt: Date;
    language?: 'hi' | 'en';
  },
): Promise<TestPrescription> {
  const user = await prisma.user.create({
    data: {
      waPhoneHash: `h-${randomUUID()}`,
      waPhoneEnc: 'enc',
      language: options.language ?? 'hi',
      onboardingStep: 'done',
      consentAt: new Date(),
      lastInboundAt: options.lastInboundAt,
    },
  });
  const message = await prisma.message.create({
    data: { userId: user.id, direction: 'in', waMessageId: `wamid.${randomUUID()}`, type: 'image' },
  });
  const document = await prisma.document.create({
    data: { userId: user.id, messageId: message.id, s3Key: `docs/${randomUUID()}.jpg` },
  });
  const start = new Date(`${options.startDate}T00:00:00.000Z`);
  const end =
    options.durationDays === null
      ? null
      : new Date(start.getTime() + (options.durationDays - 1) * 86_400_000);
  const base = {
    userId: user.id,
    documentId: document.id,
    startDate: start,
    endDate: end,
    durationDays: options.durationDays,
    confidence: 0.9,
  };
  const dolo = await prisma.medication.create({
    data: {
      ...base,
      rawName: 'Dolo 650',
      dose: '1 tablet',
      frequencyPerDay: 2,
      relationToFood: 'after',
      timings: [],
    },
  });
  const metformin = await prisma.medication.create({
    data: {
      ...base,
      rawName: 'Metformin 500',
      dose: '1 tablet',
      frequencyPerDay: 2,
      relationToFood: 'with',
      timings: [],
    },
  });
  await prisma.medication.create({
    data: {
      ...base,
      rawName: 'Crocin SOS',
      dose: '1 tablet',
      frequencyPerDay: null,
      asNeeded: true,
      timings: [],
    },
  });
  await prisma.medication.create({
    data: {
      ...base,
      rawName: '',
      dose: null,
      frequencyPerDay: null,
      active: false,
      confidence: 0.4,
      timings: [],
    },
  });
  return { userId: user.id, documentId: document.id, medicationIds: [dolo.id, metformin.id] };
}

export async function createVerifiedCaregiver(
  harness: Harness,
  userId: string,
  label = 'Papa',
): Promise<string> {
  const phone = `9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const caregiver = await harness.prisma.caregiver.create({
    data: {
      userId,
      waPhoneHash: harness.crypto.hashPhone(phone),
      waPhoneEnc: harness.crypto.encrypt(phone),
      relation: label,
      status: 'verified',
      verifiedAt: new Date(),
    },
  });
  return caregiver.id;
}

/** A ReplySession stand-in that records the i18n keys it was asked to send. */
export function fakeSession(): { session: ReplySession; texts: string[] } {
  const texts: string[] = [];
  const session = {
    text: (key: string) => {
      texts.push(key);
      return Promise.resolve();
    },
  } as unknown as ReplySession;
  return { session, texts };
}

export { epochSeconds };
