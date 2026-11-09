import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ADMIN_JWT_AUDIENCE, signAdminToken } from '@/lib/admin-token';
import { buildCsp } from '@/middleware';

const ROOT = join(__dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'lib', 'content', 'i18n'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'generated' || name === 'node_modules') return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => /\.(ts|tsx)$/.test(f));
const isClient = (text: string): boolean => /^['"]use client['"]/.test(text.trimStart());

describe('secrets stay on the server', () => {
  it('no NEXT_PUBLIC_ variable looks like a secret (only the public Turnstile site key is allowed)', () => {
    const names = new Set<string>();
    const sources = [
      ...files.map((f) => readFileSync(f, 'utf-8')),
      readFileSync(join(ROOT, '.env.example'), 'utf-8'),
    ];
    for (const text of sources) {
      for (const m of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) names.add(m[0]);
    }
    const suspicious = [...names].filter(
      (n) =>
        /SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|JWT|SERVICE/.test(n) &&
        n !== 'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    );
    expect(suspicious).toEqual([]);
  });

  it('server-only modules are never imported by a client component', () => {
    const serverOnly = ['@/lib/server-env', '@/lib/admin-token', '@/lib/gateway', 'node:crypto'];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      if (!isClient(text)) continue;
      for (const mod of serverOnly) {
        expect(text.includes(`from '${mod}'`), `${file} imports ${mod}`).toBe(false);
      }
    }
  });

  it('server secrets are never read in a client component', () => {
    const secretNames =
      /process\.env\.(DEMO_API_KEY|ADMIN_JWT_SECRET|NEXTAUTH_SECRET|AUTH_GITHUB_SECRET|GATEWAY_URL)/;
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      if (isClient(text)) expect(secretNames.test(text), file).toBe(false);
    }
  });
});

describe('Content-Security-Policy', () => {
  it('uses a nonce and never allows inline or eval scripts in production', () => {
    const csp = buildCsp('abc123', false, false);
    const script = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(script).toContain("'nonce-abc123'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('only allows Cloudflare frames when Turnstile is configured', () => {
    expect(buildCsp('n', false, true)).toContain('frame-src https://challenges.cloudflare.com');
  });
});

describe('admin token', () => {
  it('is an HS256 JWT for the admin audience that expires in 5 minutes', () => {
    const token = signAdminToken('Admin@Example.com', 'x'.repeat(32), 1_000_000);
    const [h, p, s] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      sub: 'admin@example.com',
      aud: ADMIN_JWT_AUDIENCE,
      iat: 1_000_000,
      exp: 1_000_300,
    });
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
