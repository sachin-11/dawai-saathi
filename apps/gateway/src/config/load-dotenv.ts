import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load the first `.env` found (app dir, then monorepo root) into process.env.
 * Existing environment variables always win. In production, env comes from
 * the platform (Secrets Manager → ECS), so a missing file is not an error.
 */
export function loadDotEnv(cwd: string = process.cwd()): string | undefined {
  const candidates = [resolve(cwd, '.env'), resolve(cwd, '../../.env')];
  const found = candidates.find((path) => existsSync(path));
  if (found) {
    process.loadEnvFile(found);
  }
  return found;
}
