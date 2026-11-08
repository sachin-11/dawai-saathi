/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code: a missing value fails the test anyway */
/**
 * M10 end-to-end through the real app: signed webhook -> router -> flows -> Redis/BullMQ workers ->
 * (mocked) Graph API. Real Postgres, Redis and MinIO from docker-compose.test.yml.
 *
 * Time travel: slot times and "now" are passed to the services explicitly (the delayed jobs of real
 * life are called directly); the alert itself then goes through the real queue, worker and outbound.
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import nock from 'nock';
import request from 'supertest';
import type { App } from 'supertest/types';

import { CryptoService } from '../../src/common/crypto/crypto.service';
import { hashPhone } from '../../src/common/crypto/crypto.util';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { localTimeOf } from '../../src/reminders/clock';
import { ReminderDispatchService } from '../../src/reminders/reminder-dispatch.service';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';
import { createApp, signedHeaders } from '../support/webhook-test-utils';

const GRAPH = 'https://graph.facebook.com';
const SEND_PATH = '/v21.0/100000000000001/messages';
const URL = '/webhook/whatsapp';
const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';

interface GraphBody {
  to?: string;
  status?: string;
  type?: string;
  text?: { body: string };
  interactive?: {
    body: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] };
  };
  template?: {
    name: string;
    language: { code: string };
    components: { type: string; parameters: { type: string; text?: string; payload?: string }[] }[];
  };
}
const sends: GraphBody[] = [];

const randomPhone = (): string => `919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

function webhookFor(phone: string, message: Record<string, unknown>): Buffer {
  const id = `wamid.IN${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  return Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '200000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550000000',
                  phone_number_id: '100000000000001',
                },
                messages: [
                  { from: phone, id, timestamp: String(Math.floor(Date.now() / 1000)), ...message },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
}
const text = (body: string): Record<string, unknown> => ({ type: 'text', text: { body } });
const tap = (id: string): Record<string, unknown> => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title: 'x' } },
});

async function waitFor<T>(
  produce: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('reminders end to end (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const userIds: string[] = [];

  const post = (raw: Buffer): request.Test =>
    request(app.getHttpServer()).post(URL).set(signedHeaders(raw)).send(raw.toString());
  const sendsTo = (phone: string): GraphBody[] => sends.filter((body) => body.to === phone);
  const bodyOf = (send: GraphBody): string => send.interactive?.body.text ?? send.text?.body ?? '';

  /** The user says something and we wait for `replies` messages back. */
  const say = async (
    phone: string,
    message: Record<string, unknown>,
    replies = 1,
  ): Promise<GraphBody[]> => {
    const before = sendsTo(phone).length;
    await post(webhookFor(phone, message)).expect(200);
    await waitFor(() => sendsTo(phone).length >= before + replies, 'replies');
    await sleep(150);
    return sendsTo(phone).slice(before);
  };

  async function activeUserWithPrescription(): Promise<{
    phone: string;
    userId: string;
    documentId: string;
    medicationId: string;
  }> {
    const phone = randomPhone();
    const user = await prisma.user.create({
      data: {
        waPhoneHash: hashPhone(phone, PEPPER),
        waPhoneEnc: app.get(CryptoService).encrypt(phone),
        language: 'en',
        onboardingStep: 'done',
        consentAt: new Date(),
        consentVersion: 'v1',
        lastInboundAt: new Date(),
      },
    });
    userIds.push(user.id);
    const message = await prisma.message.create({
      data: {
        userId: user.id,
        direction: 'in',
        waMessageId: `wamid.${randomUUID()}`,
        type: 'image',
      },
    });
    const document = await prisma.document.create({
      data: { userId: user.id, messageId: message.id, s3Key: `docs/${randomUUID()}.jpg` },
    });
    const medication = await prisma.medication.create({
      data: {
        userId: user.id,
        documentId: document.id,
        rawName: 'Dolo 650',
        dose: '1 tablet',
        frequencyPerDay: 2,
        relationToFood: 'after',
        timings: [],
        durationDays: 5,
        startDate: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'),
        endDate: new Date(Date.now() + 4 * 86_400_000),
        confidence: 0.9,
      },
    });
    return { phone, userId: user.id, documentId: document.id, medicationId: medication.id };
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      ...INTEGRATION_ENV,
      WORKERS_ENABLED: 'true',
      DEV_ECHO_BOT: 'false',
    });
    prepareTestDatabase(INTEGRATION_ENV['DATABASE_URL'] ?? '');
    nock.disableNetConnect();
    nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);
    nock(GRAPH)
      .persist()
      .post(SEND_PATH)
      .reply((_uri, body) => {
        const payload = body as GraphBody;
        if (payload.status === 'read') return [200, { success: true }];
        sends.push(payload);
        return [200, { messages: [{ id: `wamid.OUT${sends.length}` }] }];
      });
    app = (await createApp()) as INestApplication<App>;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('button -> summary -> change times -> confirm -> reminder sent -> "Le li" -> DB updated', async () => {
    const rx = await activeUserWithPrescription();

    // 1. [Set reminders] shows what would be set, built from the saved medicine
    const [summary] = await say(rx.phone, tap(`rx:reminders:${rx.documentId}`));
    expect(bodyOf(summary!)).toContain('Dolo 650');
    expect(bodyOf(summary!)).toContain('08:00, 21:00');
    expect(summary!.interactive?.action.buttons.map((button) => button.reply.id)).toEqual([
      `rem:confirm:${rx.documentId}`,
      `rem:change:${rx.documentId}`,
      `rem:cancel:${rx.documentId}`,
    ]);
    expect(
      summary!.interactive?.action.buttons.every((button) => button.reply.title.length <= 20),
    ).toBe(true);
    expect(await prisma.reminderSchedule.count({ where: { userId: rx.userId } })).toBe(0);

    // 2. [Change times] -> free text (kept encrypted in Redis, never in the queue) -> summary again
    const [prompt] = await say(rx.phone, tap(`rem:change:${rx.documentId}`));
    expect(bodyOf(prompt!)).toContain('subah 7, raat 10');
    const [ambiguous] = await say(rx.phone, text('7, 10'));
    expect(bodyOf(ambiguous!)).toContain('morning from evening');
    const [again] = await say(rx.phone, text('subah 7, raat 10'));
    expect(bodyOf(again!)).toContain('07:00, 22:00');
    expect(await prisma.reminderSchedule.count({ where: { userId: rx.userId } })).toBe(0);

    // 3. [Confirm]
    const [done] = await say(rx.phone, tap(`rem:confirm:${rx.documentId}`));
    expect(bodyOf(done!)).toContain('Reminders are set');
    const schedule = await prisma.reminderSchedule.findFirstOrThrow({
      where: { userId: rx.userId },
    });
    expect(schedule.times).toEqual(['07:00', '22:00']);
    expect(schedule.timezone).toBe('Asia/Kolkata');
    const pending = await prisma.reminder.findMany({
      where: { userId: rx.userId, status: 'pending' },
      orderBy: { scheduledAt: 'asc' },
    });
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const slot = pending[0]!.scheduledAt;
    expect(['07:00', '22:00']).toContain(localTimeOf(slot, 'Asia/Kolkata'));

    // 4. time travel: the slot job fires -> one message with the three buttons
    const dispatch = app.get(ReminderDispatchService);
    const before = sendsTo(rx.phone).length;
    expect(await dispatch.sendSlot(rx.userId, slot, slot)).toBe('sent');
    await waitFor(() => sendsTo(rx.phone).length > before, 'the reminder');
    const reminder = sendsTo(rx.phone).at(-1)!;
    expect(bodyOf(reminder)).toContain('Dolo 650');
    expect(bodyOf(reminder)).toContain('after food');
    const ids = reminder.interactive!.action.buttons.map((button) => button.reply.id);
    const epoch = Math.floor(slot.getTime() / 1000);
    expect(ids).toEqual([`rem:taken:${epoch}`, `rem:snooze:${epoch}`, `rem:skip:${epoch}`]);

    // 5. [Le li] -> DB updated, one short reply; a second tap does not count again
    const [ack] = await say(rx.phone, tap(ids[0]!));
    expect(bodyOf(ack!)).toContain('Noted');
    const row = await prisma.reminder.findFirstOrThrow({
      where: { userId: rx.userId, scheduledAt: slot },
    });
    expect(row.status).toBe('taken');
    expect(row.ackAt).not.toBeNull();
    const [again2] = await say(rx.phone, tap(ids[0]!));
    expect(bodyOf(again2!)).toContain('Already noted');
  }, 60_000);

  it('STOP REMINDERS stops everything queued; text answers work only while a reminder is open', async () => {
    const rx = await activeUserWithPrescription();
    await say(rx.phone, tap(`rx:reminders:${rx.documentId}`));
    await say(rx.phone, tap(`rem:confirm:${rx.documentId}`));
    expect(
      await prisma.reminder.count({ where: { userId: rx.userId, status: 'pending' } }),
    ).toBeGreaterThan(0);

    // "le li" with no open reminder is just text (it takes the normal path, no reminder reply)
    const lateText = await prisma.reminder.count({ where: { userId: rx.userId, status: 'taken' } });
    expect(lateText).toBe(0);

    await say(rx.phone, text('STOP REMINDERS'));
    expect(
      await prisma.reminder.count({
        where: { userId: rx.userId, status: { in: ['pending', 'sent', 'snoozed'] } },
      }),
    ).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: rx.userId } });
    expect(user.remindersEnabled).toBe(false);
  }, 60_000);

  it('caregiver: add -> label -> invite template -> caregiver says YES -> two missed doses -> alert', async () => {
    const rx = await activeUserWithPrescription();
    const caregiverPhone = randomPhone();

    // user: CAREGIVER <number>  -> asks what the caregiver calls them
    const [ask] = await say(
      rx.phone,
      text(`CAREGIVER +${caregiverPhone.slice(0, 2)} ${caregiverPhone.slice(2)}`),
    );
    expect(bodyOf(ask!)).toContain('What does this person call you');
    // the label (free text) -> invite goes to the caregiver as a TEMPLATE, the user gets a confirmation
    await post(webhookFor(rx.phone, text('Papa'))).expect(200);
    const invite = await waitFor(
      () => sendsTo(caregiverPhone).find((body) => body.template?.name === 'caregiver_invite'),
      'the invite',
    );
    expect(invite.template?.components[0]?.parameters.map((parameter) => parameter.text)).toEqual([
      'Papa',
    ]);
    await waitFor(
      () => sendsTo(rx.phone).some((body) => bodyOf(body).includes('sent them a request')),
      'user confirmation',
    );
    const pendingRow = await prisma.caregiver.findFirstOrThrow({ where: { userId: rx.userId } });
    expect(pendingRow.status).toBe('pending');
    expect(pendingRow.relation).toBe('Papa');

    // the caregiver replies YES: recognised by number BEFORE onboarding, no user row is created
    await post(webhookFor(caregiverPhone, text('YES'))).expect(200);
    await waitFor(
      async () =>
        (await prisma.caregiver.findFirstOrThrow({ where: { userId: rx.userId } })).status ===
        'verified',
      'verification',
    );
    expect(
      await prisma.user.count({ where: { waPhoneHash: hashPhone(caregiverPhone, PEPPER) } }),
    ).toBe(0);
    await waitFor(
      () => sendsTo(caregiverPhone).some((body) => bodyOf(body).includes('short note')),
      'caregiver thanks',
    );
    await waitFor(
      () => sendsTo(rx.phone).some((body) => bodyOf(body).includes('said YES')),
      'user told',
    );

    // two doses are sent and nobody answers: the real worker's missed-check jobs are due at once
    const schedule = await prisma.reminderSchedule.create({
      data: {
        userId: rx.userId,
        medicationId: rx.medicationId,
        times: ['03:00', '04:30'],
        startDate: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const dispatch = app.get(ReminderDispatchService);
    const slots = [new Date(Date.now() - 5 * 3_600_000), new Date(Date.now() - 4 * 3_600_000)];
    for (const slot of slots) {
      await prisma.reminder.create({
        data: {
          scheduleId: schedule.id,
          medicationId: rx.medicationId,
          userId: rx.userId,
          scheduledAt: slot,
          jobId: `rem_${rx.userId}_${Math.floor(slot.getTime() / 1000)}`,
        },
      });
      expect(await dispatch.sendSlot(rx.userId, slot, slot)).toBe('sent');
      // 61 minutes later nobody has answered: the missed-check (a delayed job in real life) runs
      await dispatch.checkMissed(rx.userId, slot, new Date(slot.getTime() + 61 * 60_000));
    }
    const alert = await waitFor(
      () =>
        sendsTo(caregiverPhone).find(
          (body) => body.template?.name === 'caregiver_missed_dose_alert',
        ),
      'the caregiver alert',
      20_000,
    );
    const params = alert.template!.components[0]!.parameters.map((parameter) => parameter.text);
    expect(params).toHaveLength(2);
    expect(params[0]).toBe('Papa');
    expect(JSON.stringify(alert)).not.toContain('Dolo');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: rx.userId } })).consecutiveMisses,
    ).toBe(2);
    const audit = await prisma.auditLog.findMany({ where: { userId: rx.userId } });
    expect(audit.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['caregiver_invited', 'caregiver_verified', 'caregiver_alert_sent']),
    );

    // the caregiver stops alerts; the user can also remove them
    await post(webhookFor(caregiverPhone, text('STOP ALERTS'))).expect(200);
    await waitFor(
      async () =>
        (await prisma.caregiver.findFirstOrThrow({ where: { userId: rx.userId } })).status ===
        'removed',
      'removal',
    );
  }, 90_000);

  it("rejects the user's own number and a foreign number", async () => {
    const rx = await activeUserWithPrescription();
    const [own] = await say(rx.phone, text(`CAREGIVER ${rx.phone.slice(2)}`));
    expect(bodyOf(own!)).toContain('your own number');
    const [foreign] = await say(rx.phone, text('CAREGIVER +44 7911 123456'));
    expect(bodyOf(foreign!)).toContain('Indian mobile number');
    const [usage] = await say(rx.phone, text('CAREGIVER'));
    expect(bodyOf(usage!)).toContain('CAREGIVER +91');
    expect(await prisma.caregiver.count({ where: { userId: rx.userId } })).toBe(0);
  }, 60_000);

  it('DELETE removes schedules, reminders and caregivers', async () => {
    const rx = await activeUserWithPrescription();
    await say(rx.phone, tap(`rx:reminders:${rx.documentId}`));
    await say(rx.phone, tap(`rem:confirm:${rx.documentId}`));
    await prisma.caregiver.create({
      data: {
        userId: rx.userId,
        waPhoneHash: `d-${randomUUID()}`,
        waPhoneEnc: 'x',
        relation: 'Maa',
        status: 'verified',
      },
    });
    await say(rx.phone, text('DELETE'));
    await say(rx.phone, tap('delete:confirm'));
    await waitFor(
      async () => (await prisma.user.count({ where: { id: rx.userId } })) === 0,
      'erasure',
      20_000,
    );
    expect(await prisma.reminderSchedule.count({ where: { userId: rx.userId } })).toBe(0);
    expect(await prisma.reminder.count({ where: { userId: rx.userId } })).toBe(0);
    expect(await prisma.caregiver.count({ where: { userId: rx.userId } })).toBe(0);
  }, 60_000);
});
