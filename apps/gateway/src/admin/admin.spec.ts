import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionContext } from '@nestjs/common';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';

import { AuditMetadataError, AuditService } from '../audit/audit.service';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { StorageService } from '../common/storage/storage.service';
import type { BudgetService } from '../limits/budget.service';
import { InMemoryWindowStore } from '../limits/sliding-window';
import type { DlqAdminService } from '../telemetry/dlq-admin.service';
import { MetricsService } from '../telemetry/metrics.service';
import { AdminDataService } from './admin-data.service';
import { AdminJwtGuard } from './admin-jwt.guard';
import { ADMIN_JWT_AUDIENCE, verifyAdminJwt } from './admin-jwt';
import {
  AdminService,
  decodeCursor,
  encodeCursor,
  MIN_REASON_CHARS,
  reviewSignals,
} from './admin.service';

const SECRET = 's'.repeat(40);
const ALLOW = ['ops@example.com'];
const NOW = 1_800_000_000;
const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function sign(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
  secret = SECRET,
): string {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${b64(header)}.${b64(payload)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: 'ops@example.com',
  aud: ADMIN_JWT_AUDIENCE,
  iat: NOW,
  exp: NOW + 300,
  ...over,
});

describe('verifyAdminJwt', () => {
  it('accepts a valid token and lowercases the e-mail', () => {
    expect(verifyAdminJwt(sign(good({ sub: 'OPS@Example.com' })), SECRET, ALLOW, NOW)).toEqual({
      ok: true,
      email: 'ops@example.com',
    });
  });

  it.each([
    ['expired', good({ iat: NOW - 1000, exp: NOW - 500 }), 'expired'],
    ['wrong audience', good({ aud: 'something-else' }), 'bad_audience'],
    ['not on the allowlist', good({ sub: 'intruder@example.com' }), 'not_allowed'],
    ['issued in the future', good({ iat: NOW + 3600, exp: NOW + 3900 }), 'not_yet_valid'],
    ['a long-lived token', good({ exp: NOW + 86_400 }), 'too_long_lived'],
    ['no expiry', { sub: 'ops@example.com', aud: ADMIN_JWT_AUDIENCE }, 'malformed'],
  ])('rejects %s', (_name, payload, reason) => {
    expect(verifyAdminJwt(sign(payload), SECRET, ALLOW, NOW)).toEqual({ ok: false, reason });
  });

  it('rejects a wrong signature, "alg: none" and a different algorithm', () => {
    expect(verifyAdminJwt(sign(good(), undefined, 'x'.repeat(40)), SECRET, ALLOW, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(good())).toString('base64url')}.`;
    expect(verifyAdminJwt(none, SECRET, ALLOW, NOW).ok).toBe(false);
    expect(verifyAdminJwt(sign(good(), { alg: 'HS512' }), SECRET, ALLOW, NOW)).toEqual({
      ok: false,
      reason: 'bad_algorithm',
    });
  });

  it('rejects garbage', () => {
    for (const token of ['', 'a.b', 'a.b.c.d', '###.###.###']) {
      expect(verifyAdminJwt(token, SECRET, ALLOW, NOW).ok).toBe(false);
    }
  });

  it('a token signed for the wrong secret cannot pass even with a valid payload', () => {
    const tampered = sign(good({ sub: 'intruder@example.com' }));
    const [h, , s] = tampered.split('.');
    const payload = Buffer.from(JSON.stringify(good())).toString('base64url');
    expect(verifyAdminJwt(`${h}.${payload}.${s}`, SECRET, ALLOW, NOW).ok).toBe(false);
  });
});

function ctx(authorization?: string): ExecutionContext {
  const response = { setHeader: jest.fn() };
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization ? { authorization } : {} }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('AdminJwtGuard', () => {
  const build = (env: { ADMIN_EMAILS?: string[]; ADMIN_JWT_SECRET?: string }) =>
    new AdminJwtGuard(env, new InMemoryWindowStore(), new MetricsService(), logger as never);
  const nowToken = (over: Record<string, unknown> = {}): string => {
    const now = Math.floor(Date.now() / 1000);
    return sign(good({ iat: now, exp: now + 300, ...over }));
  };

  it('does not exist (404) when admin is not configured', async () => {
    await expect(build({}).canActivate(ctx())).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build({ ADMIN_EMAILS: ALLOW, ADMIN_JWT_SECRET: undefined }).canActivate(ctx()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('401s without a token, with a bad token and for a non-allowlisted e-mail', async () => {
    const guard = build({ ADMIN_EMAILS: ALLOW, ADMIN_JWT_SECRET: SECRET });
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(ctx('Bearer nope'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(ctx(`Bearer ${nowToken({ sub: 'x@example.com' })}`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets a good token through and rate limits one operator', async () => {
    const guard = build({ ADMIN_EMAILS: ALLOW, ADMIN_JWT_SECRET: SECRET });
    const token = `Bearer ${nowToken()}`;
    for (let i = 0; i < 120; i++) await expect(guard.canActivate(ctx(token))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(token))).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('AuditService.logAdmin', () => {
  const build = () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const service = new AuditService({ auditLog: { create } } as unknown as PrismaService);
    return { service, create };
  };

  it('records the operator, the document and the (redacted) reason', async () => {
    const { service, create } = build();
    await service.logAdmin({
      action: 'admin_reveal',
      adminEmail: 'Ops@Example.com',
      userId: '11111111-1111-4111-8111-111111111111',
      metadata: { document_id: '22222222-2222-4222-8222-222222222222' },
      reason: 'Patient called 9876543210 about a wrong dose reading',
    });
    const data = (
      create.mock.calls[0] as [{ data: { metadata: Record<string, string>; actor: string } }]
    )[0].data;
    expect(data.actor).toBe('admin');
    expect(data.metadata.admin_email).toBe('ops@example.com');
    expect(data.metadata.reason).not.toContain('9876543210');
    expect(data.metadata.reason).toContain('wrong dose');
  });

  it('refuses a malformed e-mail and a non-machine metadata value', async () => {
    const { service } = build();
    await expect(
      service.logAdmin({ action: 'admin_reveal', adminEmail: 'not-an-email' }),
    ).rejects.toBeInstanceOf(AuditMetadataError);
    await expect(
      service.logAdmin({
        action: 'admin_reveal',
        adminEmail: 'ops@example.com',
        metadata: { note: 'free text with spaces' },
      }),
    ).rejects.toBeInstanceOf(AuditMetadataError);
  });
});

describe('reviewSignals / cursors', () => {
  it('counts unclear items and spots a critical result without returning any value', () => {
    expect(
      reviewSignals({
        medicines: [{ low_confidence: true }, { low_confidence: false }, { low_confidence: true }],
      }),
    ).toEqual({ lowConfidenceItems: 2, critical: false });
    expect(
      reviewSignals({ results: [{ status: 'critical_low' }, { needs_confirmation: true }] }),
    ).toEqual({ lowConfidenceItems: 1, critical: true });
    expect(reviewSignals(null)).toEqual({ lowConfidenceItems: 0, critical: false });
  });

  it('round-trips a cursor and rejects a forged one', () => {
    const at = new Date('2026-11-09T10:00:00.000Z');
    const id = '22222222-2222-4222-8222-222222222222';
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ createdAt: at, id });
    expect(decodeCursor('garbage')).toBeNull();
    expect(
      decodeCursor(Buffer.from("2026-11-09T10:00:00Z|1'; DROP").toString('base64url')),
    ).toBeNull();
  });
});

describe('AdminService', () => {
  const DOC_ID = '22222222-2222-4222-8222-222222222222';
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const row = {
    id: DOC_ID,
    userId: USER_ID,
    kind: 'prescription',
    status: 'needs_review',
    createdAt: new Date('2026-11-09T08:00:00Z'),
    s3Key: `media/${USER_ID}/2026/11/m.jpg`,
    extraction: {
      kind: 'prescription',
      medicines: [{ low_confidence: true, name: { value: 'Secret Drug' } }],
    },
    overallConfidence: 0.41,
    promptVersion: 'rx_extract_v1',
    model: 'm',
    reviewLabel: null,
    reviewedAt: null,
  };

  function build(overrides: { auditFails?: boolean } = {}) {
    const prisma = {
      document: {
        findUnique: jest.fn().mockResolvedValue(row),
        findMany: jest.fn().mockResolvedValue([row]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const audit = {
      logAdmin: overrides.auditFails
        ? jest.fn().mockRejectedValue(new Error('db down'))
        : jest.fn().mockResolvedValue(undefined),
    };
    const storage = { getPresignedUrl: jest.fn().mockResolvedValue('http://s3/signed') };
    const dlq = { retry: jest.fn().mockResolvedValue({ retried: 1, missing: 0 }), list: jest.fn() };
    const service = new AdminService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      storage as unknown as StorageService,
      {} as BudgetService,
      dlq as unknown as DlqAdminService,
    );
    return { service, prisma, audit, storage, dlq };
  }

  it('the review list has metadata and counts only: no extraction values, no image, no phone', async () => {
    const { service } = build();
    const page = await service.reviewQueue({ limit: 25, includeReviewed: false });
    const text = JSON.stringify(page);
    expect(text).not.toContain('Secret Drug');
    expect(text).not.toContain('s3Key');
    expect(text).not.toContain('media/');
    expect(text).not.toMatch(/wa_phone|\+?91\d{10}/);
    expect(page.items[0]).toMatchObject({
      id: DOC_ID,
      warnings: { lowConfidenceItems: 1, critical: false },
      confidence: 0.41,
    });
    expect(page.nextCursor).toBeNull();
  });

  it('paginates with a cursor when there are more rows', async () => {
    const { service, prisma } = build();
    prisma.document.findMany.mockResolvedValueOnce([
      row,
      { ...row, id: '33333333-3333-4333-8333-333333333333' },
    ]);
    const page = await service.reviewQueue({ limit: 1, includeReviewed: true });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('reveal needs a real reason and touches nothing without one', async () => {
    const { service, audit, storage, prisma } = build();
    await expect(service.reveal(DOC_ID, 'ops@example.com', 'short')).rejects.toMatchObject({
      code: 'reason_required',
    });
    expect('x'.repeat(MIN_REASON_CHARS - 1).length).toBeLessThan(MIN_REASON_CHARS);
    expect(prisma.document.findUnique).not.toHaveBeenCalled();
    expect(audit.logAdmin).not.toHaveBeenCalled();
    expect(storage.getPresignedUrl).not.toHaveBeenCalled();
  });

  it('reveal writes the audit row BEFORE returning anything, with a 60 second image link', async () => {
    const { service, audit, storage } = build();
    const result = await service.reveal(DOC_ID, 'ops@example.com', 'User reported a wrong dose');
    expect(audit.logAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_reveal',
        adminEmail: 'ops@example.com',
        userId: USER_ID,
        reason: 'User reported a wrong dose',
        metadata: { document_id: DOC_ID, kind: 'prescription' },
      }),
    );
    expect(storage.getPresignedUrl).toHaveBeenCalledWith(row.s3Key, 60);
    expect(audit.logAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      storage.getPresignedUrl.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result.imageExpiresInS).toBe(60);
    expect(result.extraction).toEqual(row.extraction);
  });

  it('reveal shows nothing when the audit row cannot be written', async () => {
    const { service, storage } = build({ auditFails: true });
    await expect(
      service.reveal(DOC_ID, 'ops@example.com', 'User reported a wrong dose'),
    ).rejects.toThrow('db down');
    expect(storage.getPresignedUrl).not.toHaveBeenCalled();
  });

  it('reveal of an unknown document is a 404 and is not audited as a view', async () => {
    const { service, prisma, audit } = build();
    prisma.document.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.reveal(DOC_ID, 'ops@example.com', 'User reported a wrong dose'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(audit.logAdmin).not.toHaveBeenCalled();
  });

  it('resolve stores the label, a hash of the reviewer and an audit row', async () => {
    const { service, prisma, audit } = build();
    await service.resolve(DOC_ID, 'ops@example.com', 'extraction_wrong');
    const data = (
      prisma.document.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data.reviewLabel).toBe('extraction_wrong');
    expect(String(data.reviewedByHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain('ops@example.com');
    expect(audit.logAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_review_resolved',
        metadata: { document_id: DOC_ID, label: 'extraction_wrong' },
      }),
    );
  });

  it('dlq retry validates the queue and audits with a hash, not the job id', async () => {
    const { service, audit, dlq } = build();
    await expect(service.dlqRetry('nope', 'job1', 'ops@example.com')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await service.dlqRetry('inbound', 'wamid.HBgM+Zz==', 'ops@example.com');
    expect(dlq.retry).toHaveBeenCalledWith('inbound', { jobId: 'wamid.HBgM+Zz==' });
    const meta = (audit.logAdmin.mock.calls[0] as [{ metadata: Record<string, unknown> }])[0]
      .metadata;
    expect(JSON.stringify(meta)).not.toContain('wamid');
    expect(meta.job_ref).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('AdminDataService', () => {
  it('reads the synced eval reports (newest first) and prompts; missing folder is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'admin-data-'));
    await mkdir(join(dir, 'eval-reports'));
    const report = (date: string, passed: boolean) =>
      JSON.stringify({
        date,
        git_sha: 'abc',
        scope: 'all suites, mode fake',
        passed,
        runs: [
          {
            suite: 'emergency',
            mode: 'rules',
            cases: 3,
            passed,
            hard_gates: [{ metric: 'recall', rule: '== 1.0', value: 1, passed }],
            soft: [{ status: 'ok' }, { status: 'regressed' }],
            cost_usd: 0,
            latency_p95_ms: 0,
          },
        ],
      });
    await writeFile(join(dir, 'eval-reports', 'a.json'), report('2026-11-01', true));
    await writeFile(join(dir, 'eval-reports', 'b.json'), report('2026-11-09', false));
    await writeFile(join(dir, 'eval-reports', 'broken.json'), '{nope');
    await writeFile(
      join(dir, 'prompts.json'),
      JSON.stringify([
        { id: 'rx_extract_v1', family: 'rx_extract', version: 1, file: 'x', current: true },
      ]),
    );
    const service = new AdminDataService({ ADMIN_DATA_DIR: dir });
    const reports = await service.evals();
    expect(reports.map((r) => r.date)).toEqual(['2026-11-09', '2026-11-01']);
    expect(reports[0]?.runs[0]).toMatchObject({
      suite: 'emergency',
      softRegressions: 1,
      passed: false,
    });
    expect(await service.prompts()).toHaveLength(1);
    const empty = new AdminDataService({ ADMIN_DATA_DIR: join(dir, 'missing') });
    expect(await empty.evals()).toEqual([]);
    expect(await empty.prompts()).toEqual([]);
  });
});
