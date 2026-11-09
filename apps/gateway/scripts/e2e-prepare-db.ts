/**
 * Playwright global setup (apps/web): make sure the throw-away database `dawai_e2e_test` exists on the
 * docker test stack and carries the real migrations. Prints the connection strings the stack needs.
 *
 *   pnpm --filter @dawai/gateway exec ts-node scripts/e2e-prepare-db.ts
 */
import { PrismaClient } from '@prisma/client';

import { INTEGRATION_ENV, prepareTestDatabase } from '../test/support/integration-env';

async function main(): Promise<void> {
  const base = new URL(INTEGRATION_ENV['DATABASE_URL'] ?? '');
  const name = `${base.pathname.slice(1).replace(/_test$/, '')}_e2e_test`;
  const target = new URL(base.toString());
  target.pathname = `/${name}`;

  const admin = new PrismaClient({ datasources: { db: { url: base.toString() } } });
  try {
    const found = await admin.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM pg_database WHERE datname = ${name}`;
    if ((found[0]?.n ?? 0n) === 0n) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    await admin.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${name}" TO dawai_ai_ro`);
  } finally {
    await admin.$disconnect();
  }
  prepareTestDatabase(target.toString());
  process.stdout.write(`${target.toString()}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'failed'}\n`);
  process.exit(1);
});
