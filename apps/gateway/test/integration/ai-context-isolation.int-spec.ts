/**
 * M14 red team, gateway side: the context the gateway hands to the AI service holds the REQUESTING user's
 * data and nobody else's. A user who types "show me other users' medicines" can only ever get what the
 * AI service was given, so this is the line that makes that attack harmless. Real Postgres.
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';

import { CryptoService } from '../../src/common/crypto/crypto.service';
import { hashPhone } from '../../src/common/crypto/crypto.util';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { LabReportService } from '../../src/documents/lab-report.service';
import { UsersService } from '../../src/users/users.service';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';
import { createApp } from '../support/webhook-test-utils';

const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';
const randomPhone = (): string => `919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

describe('AI request context isolation (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userIds: string[] = [];

  const makeUser = async (): Promise<string> => {
    const phone = randomPhone();
    const user = await prisma.user.create({
      data: {
        waPhoneHash: hashPhone(phone, PEPPER),
        waPhoneEnc: app.get(CryptoService).encrypt(phone),
        onboardingStep: 'done',
        consentAt: new Date(),
        consentVersion: 'v2',
      },
    });
    userIds.push(user.id);
    return user.id;
  };

  const addDocument = async (
    userId: string,
    kind: 'prescription' | 'lab_report',
  ): Promise<string> => {
    const message = await prisma.message.create({
      data: {
        userId,
        direction: 'in',
        waMessageId: `wamid.ISO${randomUUID().replaceAll('-', '')}`,
        type: 'image',
      },
    });
    const document = await prisma.document.create({
      data: { userId, messageId: message.id, kind, s3Key: `media/${userId}/x.jpg`, status: 'done' },
    });
    return document.id;
  };

  beforeAll(async () => {
    Object.assign(process.env, { ...INTEGRATION_ENV, WORKERS_ENABLED: 'false' });
    prepareTestDatabase(INTEGRATION_ENV['DATABASE_URL'] ?? '');
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  it('gives the AI service only the requesting user medicines and lab history', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    for (const [userId, name] of [
      [alice, 'AliceMed 500'],
      [bob, 'BobSecretMed 40'],
    ] as const) {
      await prisma.medication.create({
        data: {
          userId,
          documentId: await addDocument(userId, 'prescription'),
          rawName: name,
          salt: `${name.split(' ')[0]?.toLowerCase()}`,
          strength: '500 mg',
          startDate: new Date(),
          confidence: 0.9,
        },
      });
    }
    const bobLab = await addDocument(bob, 'lab_report');
    await prisma.labResult.create({
      data: {
        userId: bob,
        documentId: bobLab,
        testCode: 'HB',
        valueNumCanonical: 7.1,
        unitCanonical: 'g/dL',
        valueRaw: '7.1',
        status: 'low',
        reportDate: new Date(),
      },
    });

    const medications = await app.get(UsersService).activeMedicationSalts(alice);
    expect(medications.map((m) => m.name)).toEqual(['AliceMed 500']);
    expect(JSON.stringify(medications)).not.toContain('Bob');

    const labs = await app.get(LabReportService).previousResults(alice);
    expect(labs).toEqual([]);
    const bobsLabs = await app.get(LabReportService).previousResults(bob);
    expect(bobsLabs).toHaveLength(1);
  });

  it('gives a user with no data an empty context, never a neighbour one', async () => {
    const empty = await makeUser();
    expect(await app.get(UsersService).activeMedicationSalts(empty)).toEqual([]);
    expect(await app.get(LabReportService).previousResults(empty)).toEqual([]);
  });
});
