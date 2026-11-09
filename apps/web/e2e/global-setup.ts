import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Make sure the e2e database exists and carries the migrations (the gateway app has the tooling). */
export default function globalSetup(): void {
  const gateway = join(__dirname, '..', '..', 'gateway');
  execFileSync(
    process.execPath,
    [join(gateway, 'node_modules', 'ts-node', 'dist', 'bin.js'), 'scripts/e2e-prepare-db.ts'],
    {
      cwd: gateway,
      stdio: 'inherit',
    },
  );
}
