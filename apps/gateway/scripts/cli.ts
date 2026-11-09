/**
 * Operator CLI (M15):
 *
 *   pnpm --filter @dawai/gateway cli dlq:list   --queue inbound
 *   pnpm --filter @dawai/gateway cli dlq:retry  --queue user-deletion [--job <id>]
 *   pnpm --filter @dawai/gateway cli dlq:purge  --queue outbound
 *   pnpm --filter @dawai/gateway cli user:unblock --user <uuid>
 *
 * Boots the Nest app context WITHOUT workers (WORKERS_ENABLED=false), so it never takes jobs.
 * Every change writes an audit_logs row (actor=admin). Output has ids, counts and codes only.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { loadDotEnv } from '../src/config/load-dotenv';
import { RateLimitService } from '../src/limits/rate-limit.service';
import { DlqAdminService, assertSourceQueue } from '../src/telemetry/dlq-admin.service';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write('usage: cli <dlq:list|dlq:retry|dlq:purge|user:unblock> [options]\n');
    return 2;
  }
  loadDotEnv();
  process.env['WORKERS_ENABLED'] = 'false';
  process.env['LOG_LEVEL'] = process.env['CLI_LOG_LEVEL'] ?? 'silent'; // stdout is the command's output: JSON only
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const admin = app.get(DlqAdminService);
    switch (command) {
      case 'dlq:list': {
        const listing = await admin.list(assertSourceQueue(option(args, 'queue') ?? ''));
        process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`);
        return 0;
      }
      case 'dlq:retry': {
        const queue = assertSourceQueue(option(args, 'queue') ?? '');
        const jobId = option(args, 'job');
        process.stdout.write(
          `${JSON.stringify(await admin.retry(queue, jobId ? { jobId } : {}))}\n`,
        );
        return 0;
      }
      case 'dlq:purge': {
        const result = await admin.purge(assertSourceQueue(option(args, 'queue') ?? ''));
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
      }
      case 'user:unblock': {
        const user = option(args, 'user');
        if (!user) throw new Error('--user <uuid> is required');
        const done = await app.get(RateLimitService).unblock(user);
        process.stdout.write(`${JSON.stringify({ unblocked: done })}\n`);
        return done ? 0 : 1;
      }
      default:
        process.stderr.write(`unknown command "${command}"\n`);
        return 2;
    }
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'failed'}\n`);
    process.exit(1);
  });
