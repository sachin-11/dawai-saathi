// `pnpm scan:bundle` (after `next build`): fail if the VALUE of any server-side secret appears in what the
// browser downloads (.next/static) or in prerendered HTML. Secrets come from the environment and
// apps/web/.env.local; a variable counts as a secret when its name says so and it is not NEXT_PUBLIC_*.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(join(root, name));
  } catch {
    // optional
  }
}

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|API_KEY|JWT|PEPPER|ENCRYPTION_KEY|DEMO_API_KEY)/i;
const secrets = Object.entries(process.env)
  .filter(([name, value]) => SECRET_NAME.test(name) && !name.startsWith('NEXT_PUBLIC_'))
  .filter(([, value]) => typeof value === 'string' && value.length >= 12)
  // a public Cloudflare/GitHub id is not a secret; tool-injected CI tokens are not ours to protect here
  .filter(([name]) => !/^(npm_|GITHUB_TOKEN|ACTIONS_|RUNNER_|ANTHROPIC|OPENAI)/.test(name))
  .map(([name, value]) => ({ name, value: value }));

function* walk(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|css|html|json|txt|map|rsc)$/.test(name)) yield full;
  }
}

const targets = [join(root, '.next', 'static'), join(root, '.next', 'server', 'app')];
let files = 0;
const leaks = [];
for (const dir of targets) {
  for (const file of walk(dir)) {
    // server-only route handlers/chunks live under .next/server; only prerendered HTML there matters
    if (dir.includes(join('server', 'app')) && !file.endsWith('.html') && !file.endsWith('.rsc'))
      continue;
    files += 1;
    const text = readFileSync(file, 'utf-8');
    for (const { name, value } of secrets) {
      if (text.includes(value)) leaks.push(`${name} found in ${file.replace(root, '.')}`);
    }
  }
}

if (files === 0) {
  console.error('[scan-bundle] nothing to scan: run `next build` first');
  process.exit(2);
}
if (leaks.length > 0) {
  console.error(`[scan-bundle] SECRET VALUES IN THE CLIENT BUNDLE:\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `[scan-bundle] ${files} files scanned against ${secrets.length} secret value(s): clean`,
);
