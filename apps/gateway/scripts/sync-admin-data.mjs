// `pnpm --filter @dawai/gateway sync:admin-data` (run by `make admin-data`, by `make dev` and at image build).
// Copies the eval reports (evals/reports/*.json) and builds the prompt list from the AI service's prompt
// files into apps/gateway/admin-data/, because the gateway image cannot see those folders.
// Prompt rule (docs/eval-process.md): a prompt file is never edited, the next `<family>_vN.md` is created,
// so the highest version of a family is the current one.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const out = join(here, '..', 'admin-data');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'eval-reports'), { recursive: true });

const reports = join(repo, 'evals', 'reports');
let copied = 0;
if (existsSync(reports)) {
  for (const name of readdirSync(reports).filter((n) => n.endsWith('.json'))) {
    copyFileSync(join(reports, name), join(out, 'eval-reports', name));
    copied += 1;
  }
}

const promptsDir = join(repo, 'apps', 'ai-service', 'app', 'prompts', 'files');
const prompts = [];
if (existsSync(promptsDir)) {
  for (const file of readdirSync(promptsDir).filter((n) => n.endsWith('.md'))) {
    const id = file.replace(/\.md$/, '');
    const match = id.match(/^(.*)_v(\d+)$/);
    if (!match) continue;
    prompts.push({ id, family: match[1], version: Number(match[2]), file, current: false });
  }
}
const latest = new Map();
for (const p of prompts) latest.set(p.family, Math.max(latest.get(p.family) ?? 0, p.version));
for (const p of prompts) p.current = latest.get(p.family) === p.version;
prompts.sort((a, b) => a.family.localeCompare(b.family) || b.version - a.version);
writeFileSync(join(out, 'prompts.json'), `${JSON.stringify(prompts, null, 2)}\n`);
console.log(`[admin-data] ${copied} eval reports, ${prompts.length} prompts`);
