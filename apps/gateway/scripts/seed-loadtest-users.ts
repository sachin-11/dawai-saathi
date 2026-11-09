/**
 * Seeds fictional, fully onboarded users for the k6 smoke test (infra/loadtest/smoke.js):
 * phone numbers 919000000000 + n. Refuses to run unless the database name ends with `_test` or
 * `_load`, so it can never add fake users to real data.
 *
 *   DATABASE_URL=postgresql://...@localhost:5543/dawai_test pnpm --filter @dawai/gateway exec ts-node scripts/seed-loadtest-users.ts
 */
import { randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { CryptoService } from '../src/common/crypto/crypto.service';
import { loadDotEnv } from '../src/config/load-dotenv';
import { validateEnv } from '../src/config/env.schema';

async function main(): Promise<void> {
  loadDotEnv();
  const env = validateEnv(process.env);
  const dbName = new URL(env.DATABASE_URL).pathname.slice(1);
  if (!/_(test|load)$/.test(dbName)) {
    throw new Error(`refusing to seed fake users into database "${dbName}"`);
  }
  const count = Number(process.argv[2] ?? '200');
  const crypto = new CryptoService(env);
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  try {
    let created = 0;
    for (let n = 0; n < count; n++) {
      const phone = String(919000000000 + n);
      const result = await prisma.user.upsert({
        where: { waPhoneHash: crypto.hashPhone(phone) },
        create: {
          waPhoneHash: crypto.hashPhone(phone),
          waPhoneEnc: crypto.encrypt(phone),
          language: 'en',
          onboardingStep: 'done',
          consentAt: new Date(),
          consentVersion: 'v2',
          lastInboundAt: new Date(),
        },
        update: { onboardingStep: 'done', lastInboundAt: new Date(), blockedUntil: null },
        select: { id: true },
      });
      if (result.id) created += 1;
    }
    process.stdout.write(`seeded ${created} users (run id ${randomBytes(3).toString('hex')})\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'failed'}\n`);
  process.exit(1);
});
