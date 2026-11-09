/**
 * `make demo-cache`: run every bundled sample through a RUNNING gateway (as a real upload, so the whole
 * pipeline including the trace is exercised) and store the answers in `demo-cache/<id>.<lang>.json`.
 * The playground serves these when the demo budget is spent, and always for the bundled samples.
 *
 * Needs: the gateway with DEMO_API_KEY + DEMO_SERVICE_TOKEN (and TURNSTILE_SKIP=true or no Turnstile
 * secret outside production), MinIO, and the AI service. With LLM_MODE=fake the answers show the
 * plumbing only (the fake model does not read pixels): regenerate with real keys before a public demo.
 *
 * Env: GATEWAY_URL (default http://localhost:3000), DEMO_API_KEY.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const KEY = process.env.DEMO_API_KEY ?? '';
const SAMPLES_DIR = join(__dirname, '..', '..', 'web', 'public', 'samples');
const OUT_DIR = join(__dirname, '..', 'demo-cache');

interface SampleEntry {
  id: string;
  file: string;
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('DEMO_API_KEY is required');
  const samples = JSON.parse(
    await readFile(join(SAMPLES_DIR, 'samples.json'), 'utf-8'),
  ) as SampleEntry[];
  await mkdir(OUT_DIR, { recursive: true });
  let n = 0;
  for (const sample of samples) {
    const bytes = await readFile(join(SAMPLES_DIR, sample.file));
    for (const language of ['hi', 'en'] as const) {
      const form = new FormData();
      form.set('language', language);
      form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), sample.file);
      const response = await fetch(`${GATEWAY}/demo/process`, {
        method: 'POST',
        headers: { 'X-Demo-Key': KEY, 'X-Demo-Client-Ip': `cache-builder-${n++}` },
        body: form,
      });
      if (!response.ok) {
        throw new Error(
          `${sample.id}/${language}: HTTP ${response.status} ${await response.text()}`,
        );
      }
      const rest = (await response.json()) as Record<string, unknown>;
      delete rest.cached;
      delete rest.uploads_enabled;
      await writeFile(
        join(OUT_DIR, `${sample.id}.${language}.json`),
        `${JSON.stringify(rest, null, 2)}\n`,
      );
      process.stdout.write(`${sample.id}.${language}: ok
`);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'failed'}
`);
  process.exit(1);
});
