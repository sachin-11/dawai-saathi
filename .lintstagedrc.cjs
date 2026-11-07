const path = require('node:path');

const AI_DIR = path.join(__dirname, 'apps', 'ai-service');
const GATEWAY_DIR = path.join(__dirname, 'apps', 'gateway');

const quote = (files) => files.map((f) => JSON.stringify(f)).join(' ');
const relativeTo = (dir, files) => files.map((f) => path.relative(dir, f));

module.exports = {
  // Gateway TS: eslint (fix) + prettier, run from the app dir so its eslint config applies.
  'apps/gateway/**/*.ts': (files) => [
    `pnpm --dir apps/gateway exec eslint --fix ${quote(relativeTo(GATEWAY_DIR, files))}`,
    `prettier --write ${quote(files)}`,
  ],
  // Other JS/JSON/YAML at the root and in packages.
  '*.{js,cjs,mjs,json,yml,yaml}': (files) => `prettier --write --ignore-unknown ${quote(files)}`,
  // Python: ruff lint (fix) + format, using the ai-service's uv environment.
  'apps/ai-service/**/*.py': (files) => {
    const rel = quote(relativeTo(AI_DIR, files));
    return [
      `uv run --directory apps/ai-service ruff check --fix ${rel}`,
      `uv run --directory apps/ai-service ruff format ${rel}`,
    ];
  },
};
