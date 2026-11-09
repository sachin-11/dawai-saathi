// Runs before `next dev` and `next build`. Writes lib/generated/*:
//   eval-summary.json  numbers from the newest full eval report (evals/reports/*.json)
//   graph.json         the LangGraph pipeline (docs/architecture/graph.mmd) as nodes + edges + layers
//   qr.json            the "Send Hi on WhatsApp" QR code as an inline SVG string
// Everything is generated at build time, so the landing page ships no client code for any of it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import QRCode from 'qrcode';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const repoRoot = join(webRoot, '..', '..');
const outDir = join(webRoot, 'lib', 'generated');
mkdirSync(outDir, { recursive: true });

for (const name of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(join(webRoot, name));
  } catch {
    // optional
  }
}
const strict = process.env.NODE_ENV === 'production' || process.env.CI === 'true';

// ------------------------------------------------------------------ eval summary
/** When a report was committed (git), else its file time: file names carry a sha, not an order. */
function reportTime(dir, file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', join(dir, file)], {
      cwd: repoRoot,
      encoding: 'utf-8',
    }).trim();
    if (out) return Number(out) * 1000;
  } catch {
    // not a git checkout
  }
  return statSync(join(dir, file)).mtimeMs;
}

function buildEvalSummary() {
  const dir = join(repoRoot, 'evals', 'reports');
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('-e2e-'))
    : [];
  const reports = files
    .map((file) => ({
      file,
      time: reportTime(dir, file),
      data: JSON.parse(readFileSync(join(dir, file), 'utf-8')),
    }))
    .filter((r) => Array.isArray(r.data.runs) && r.data.runs.length >= 8)
    .sort((a, b) => a.time - b.time || a.data.runs.length - b.data.runs.length);
  const latest = reports.at(-1);
  if (!latest) {
    if (strict)
      throw new Error('no full eval report found in evals/reports (run `make eval` first)');
    console.warn('[prepare-build] no eval report found, landing shows no eval numbers');
    return { available: false };
  }
  const { data } = latest;
  const suites = data.runs.map((run) => ({
    suite: run.suite,
    mode: run.mode,
    cases: run.cases,
    passed: run.passed,
    hardGatesPassed: run.hard_gates.filter((g) => g.passed).length,
    hardGatesTotal: run.hard_gates.length,
  }));
  return {
    available: true,
    date: data.date,
    sha: data.git_sha,
    scope: data.scope,
    passed: data.passed,
    suites,
    totals: {
      suites: suites.length,
      cases: suites.reduce((n, s) => n + s.cases, 0),
      hardGatesPassed: suites.reduce((n, s) => n + s.hardGatesPassed, 0),
      hardGatesTotal: suites.reduce((n, s) => n + s.hardGatesTotal, 0),
    },
  };
}

// ------------------------------------------------------------------ graph
function buildGraph() {
  const text = readFileSync(join(repoRoot, 'docs', 'architecture', 'graph.mmd'), 'utf-8');
  const nodes = new Set();
  const edges = [];
  for (const line of text.split('\n')) {
    const edge = line.match(/^\s*(\w+)\s+-\.?->\s+(\w+);/);
    if (edge) {
      edges.push({ from: edge[1], to: edge[2] });
      nodes.add(edge[1]);
      nodes.add(edge[2]);
    }
  }
  // Longest-path layering (the graph is a DAG).
  const layer = new Map([...nodes].map((n) => [n, 0]));
  for (let pass = 0; pass < nodes.size; pass++) {
    let changed = false;
    for (const { from, to } of edges) {
      if (layer.get(to) < layer.get(from) + 1) {
        layer.set(to, layer.get(from) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byLayer = new Map();
  for (const n of nodes) {
    const l = layer.get(n);
    byLayer.set(l, [...(byLayer.get(l) ?? []), n]);
  }
  const list = [];
  for (const [l, names] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    names
      .sort()
      .forEach((name, index) => list.push({ id: name, layer: l, index, of: names.length }));
  }
  return { nodes: list, edges, layers: byLayer.size };
}

// ------------------------------------------------------------------ QR
async function buildQr() {
  const number = (process.env.NEXT_PUBLIC_WA_NUMBER ?? '').replace(/\D/g, '');
  if (!number) {
    if (strict) throw new Error('NEXT_PUBLIC_WA_NUMBER is required for a production build');
    console.warn('[prepare-build] NEXT_PUBLIC_WA_NUMBER not set, QR points at a placeholder');
  }
  const url = `https://wa.me/${number || '910000000000'}?text=Hi`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { url, svg };
}

writeFileSync(join(outDir, 'eval-summary.json'), JSON.stringify(buildEvalSummary(), null, 2));
writeFileSync(join(outDir, 'graph.json'), JSON.stringify(buildGraph(), null, 2));
writeFileSync(join(outDir, 'qr.json'), JSON.stringify(await buildQr(), null, 2));
console.log('[prepare-build] generated eval-summary, graph and qr');
