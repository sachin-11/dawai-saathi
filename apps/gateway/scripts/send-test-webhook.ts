/**
 * Send a sample WhatsApp webhook to a locally running gateway, signed exactly like Meta signs it.
 * Lets you test the whole inbound path without a Meta account or a tunnel.
 *
 *   make webhook FIXTURE=text
 *   make webhook FIXTURE=batch WEBHOOK_URL=http://localhost:3010/webhook/whatsapp
 *   make webhook FIXTURE=text BAD_SIGNATURE=1      # expect 401
 *   make webhook FIXTURE=text FRESH=1              # new sender + new message ids every time
 *
 * Fixtures live in test/fixtures/whatsapp/*.json (fake numbers only). Without FRESH the message ids
 * are fixed, so running the same fixture twice shows idempotency: no new row, no new job.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDotEnv } from '../src/config/load-dotenv';
import { signBody } from '../src/webhook/whatsapp-signature';

const FIXTURE_DIR = join(__dirname, '..', 'test', 'fixtures', 'whatsapp');
const FIXTURE_PHONE = '919999999999';

async function main(): Promise<void> {
  loadDotEnv();

  const name = process.argv[2] ?? process.env['FIXTURE'] ?? 'text';
  const file = join(FIXTURE_DIR, `${name}.json`);
  if (!existsSync(file)) {
    const available = readdirSync(FIXTURE_DIR)
      .map((entry) => entry.replace(/\.json$/, ''))
      .join(', ');
    process.stderr.write(`Unknown fixture "${name}". Available: ${available}\n`);
    process.exit(2);
  }

  const secret = process.env['WA_APP_SECRET'];
  if (!secret) {
    process.stderr.write('WA_APP_SECRET is not set (copy .env.example to .env).\n');
    process.exit(2);
  }

  let body = readFileSync(file, 'utf8');
  if (process.env['FRESH']) {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const phone = `919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    body = body.replaceAll(FIXTURE_PHONE, phone).replaceAll('wamid.', `wamid.${tag}.`);
  }
  const raw = Buffer.from(body);

  const url =
    process.env['WEBHOOK_URL'] ??
    `http://localhost:${process.env['PORT'] ?? '3000'}/webhook/whatsapp`;
  const signature = process.env['BAD_SIGNATURE']
    ? `sha256=${'0'.repeat(64)}`
    : signBody(raw, secret);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body: raw,
  });
  const text = await response.text();
  process.stdout.write(`POST ${url}  fixture=${name}\n-> HTTP ${response.status} ${text}\n`);
  process.exit(response.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Could not reach the gateway (is it running? try \`make dev\`): ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
