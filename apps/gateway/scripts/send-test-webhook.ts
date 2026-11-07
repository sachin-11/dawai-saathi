/**
 * Send a sample WhatsApp webhook to a locally running gateway, signed exactly like Meta signs it.
 * Lets you test the whole inbound path without a Meta account or a tunnel.
 *
 *   make webhook FIXTURE=text
 *   make webhook FIXTURE=batch WEBHOOK_URL=http://localhost:3010/webhook/whatsapp
 *   make webhook FIXTURE=text BAD_SIGNATURE=1      # expect 401
 *   make webhook FIXTURE=text FRESH=1              # new sender + new message ids every time
 *
 * To act as ONE user through a whole conversation (onboarding, consent, commands, DELETE) keep the
 * sender and only change the message ids:
 *
 *   make webhook FIXTURE=text      PHONE=919888800001 NEW_IDS=1    # first message -> language buttons
 *   make webhook FIXTURE=lang-en   PHONE=919888800001 NEW_IDS=1    # tap "English"  -> consent message
 *   make webhook FIXTURE=consent-yes PHONE=919888800001 NEW_IDS=1  # tap "I agree"  -> welcome
 *   make webhook FIXTURE=help      PHONE=919888800001 NEW_IDS=1
 *
 * Fixtures live in test/fixtures/whatsapp/*.json (fake numbers only). By default the message ids are
 * fixed, so running the same fixture twice shows idempotency: no new row, no new job.
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
  const fresh = Boolean(process.env['FRESH']);
  const phone =
    process.env['PHONE'] ??
    (fresh ? `919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}` : undefined);
  if (phone) {
    body = body.replaceAll(FIXTURE_PHONE, phone);
  }
  if (fresh || process.env['NEW_IDS']) {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    body = body.replaceAll('wamid.', `wamid.${tag}.`);
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
