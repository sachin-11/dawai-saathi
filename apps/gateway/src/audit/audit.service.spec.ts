import type { PrismaService } from '../common/prisma/prisma.service';
import { AuditMetadataError, AuditService, assertSafeAuditMetadata } from './audit.service';

describe('assertSafeAuditMetadata', () => {
  it.each<[string, unknown]>([
    ['language', { language: 'hi' }],
    ['consent version', { version: 'v1' }],
    [
      'erasure counts (nested numbers)',
      { s3_objects_deleted: 3, rows_deleted_by_table: { messages: 7, users: 1 } },
    ],
    ['booleans and null', { ok: true, reason: null }],
    ['an empty object', {}],
    ['an array of tokens', { actions: ['consent_given', 'language_changed'] }],
  ])('accepts %s', (_name, metadata) => {
    expect(() => {
      assertSafeAuditMetadata(metadata);
    }).not.toThrow();
  });

  it.each<[string, unknown]>([
    ['a 10-digit mobile number', { phone: '9876543210' }],
    ['a number with country code', { value: '919876543210' }],
    ['a +91 number', { value: '+919876543210' }],
    ['an Aadhaar-like number', { id: '234567890123' }],
    ['a PIN code', { pin: '411001' }],
    ['an email address', { contact: 'ramesh@example.com' }],
    ["a person's name (has a space)", { name: 'Ramesh Sharma' }],
    ['message text', { text: 'Dolo 650 kab leni hai' }],
    ['a sentence with punctuation', { note: 'He said: hello!' }],
    ['an over-long token', { value: 'a'.repeat(65) }],
    ['a key that is not snake_case', { 'Phone Number': 'x' }],
    ['an upper-case key', { Language: 'hi' }],
    ['a non-finite number', { n: Number.POSITIVE_INFINITY }],
    ['a function', { fn: () => 1 }],
    ['too deep nesting', { a: { b: { c: { d: { e: 1 } } } } }],
  ])('rejects %s', (_name, metadata) => {
    expect(() => {
      assertSafeAuditMetadata(metadata);
    }).toThrow(AuditMetadataError);
  });

  it('never echoes the offending value in the error', () => {
    try {
      assertSafeAuditMetadata({ language: 'Ramesh Sharma 9876543210' });
      fail('expected a throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('Ramesh');
      expect((error as Error).message).not.toContain('9876543210');
      expect((error as Error).message).toContain('language');
    }
  });
});

describe('AuditService.log', () => {
  const setup = (): { service: AuditService; create: jest.Mock } => {
    const create = jest.fn().mockResolvedValue({});
    const service = new AuditService({ auditLog: { create } } as unknown as PrismaService);
    return { service, create };
  };

  it('writes actor, user, action and metadata', async () => {
    const { service, create } = setup();
    await service.log({
      actor: 'user',
      userId: 'u1',
      action: 'consent_given',
      metadata: { version: 'v1' },
    });
    expect(create).toHaveBeenCalledWith({
      data: { actor: 'user', userId: 'u1', action: 'consent_given', metadata: { version: 'v1' } },
    });
  });

  it('defaults metadata to {} and allows an anonymous (null) user', async () => {
    const { service, create } = setup();
    await service.log({ actor: 'system', userId: null, action: 'user_deleted' });
    expect(create).toHaveBeenCalledWith({
      data: { actor: 'system', userId: null, action: 'user_deleted', metadata: {} },
    });
  });

  it('refuses PII-looking metadata BEFORE touching the database', async () => {
    const { service, create } = setup();
    await expect(
      service.log({
        actor: 'user',
        userId: 'u1',
        action: 'language_changed',
        metadata: { phone: '9876543210' },
      }),
    ).rejects.toBeInstanceOf(AuditMetadataError);
    expect(create).not.toHaveBeenCalled();
  });
});
