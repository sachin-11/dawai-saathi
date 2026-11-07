import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../config/env.schema';
import { signBody, verifySignature } from './whatsapp-signature';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard';

const SECRET = 'app-secret-123';
const body = Buffer.from(JSON.stringify({ entry: [{ id: '1', changes: [] }] }));

describe('verifySignature', () => {
  it('accepts a correct signature', () => {
    expect(verifySignature(body, signBody(body, SECRET), SECRET)).toBe(true);
  });

  it('accepts an upper-case hex digest', () => {
    const signature = signBody(body, SECRET);
    const upper = `sha256=${signature.slice('sha256='.length).toUpperCase()}`;
    expect(verifySignature(body, upper, SECRET)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifySignature(body, signBody(body, 'other-secret'), SECRET)).toBe(false);
  });

  it('rejects when the body changed after signing', () => {
    const signature = signBody(body, SECRET);
    expect(verifySignature(Buffer.from(`${body.toString()} `), signature, SECRET)).toBe(false);
  });

  it('is computed on raw bytes: re-serialised JSON no longer matches', () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifySignature(pretty, signBody(body, SECRET), SECRET)).toBe(false);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['no sha256= prefix', signBody(body, SECRET).slice('sha256='.length)],
    ['sha1 prefix', signBody(body, SECRET).replace('sha256=', 'sha1=')],
    ['too short', 'sha256=abcd'],
    ['not hex', `sha256=${'z'.repeat(64)}`],
    ['trailing garbage', `${signBody(body, SECRET)}00`],
  ])('rejects %s', (_name, header) => {
    expect(verifySignature(body, header, SECRET)).toBe(false);
  });

  it('rejects when there is no raw body', () => {
    expect(verifySignature(undefined, signBody(body, SECRET), SECRET)).toBe(false);
  });
});

describe('WhatsAppSignatureGuard', () => {
  const warn = jest.fn();
  const guard = new WhatsAppSignatureGuard(
    { WA_APP_SECRET: SECRET } as Env,
    {
      warn,
      setContext: jest.fn(),
    } as unknown as PinoLogger,
  );

  const contextFor = (headers: Record<string, string>, rawBody?: Buffer): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers, rawBody }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    warn.mockClear();
  });

  it('lets a correctly signed request through', () => {
    const ctx = contextFor({ 'x-hub-signature-256': signBody(body, SECRET) }, body);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws 401 for a wrong secret', () => {
    const ctx = contextFor({ 'x-hub-signature-256': signBody(body, 'nope') }, body);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws 401 when the header is missing', () => {
    expect(() => guard.canActivate(contextFor({}, body))).toThrow(UnauthorizedException);
  });

  it('throws 401 when the body was altered after signing', () => {
    const ctx = contextFor(
      { 'x-hub-signature-256': signBody(body, SECRET) },
      Buffer.from('{"entry":[]}'),
    );
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('logs a fixed warning only: no body, no signature, no secret', () => {
    const header = signBody(body, 'nope');
    expect(() => guard.canActivate(contextFor({ 'x-hub-signature-256': header }, body))).toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(header);
    expect(logged).not.toContain(body.toString());
    expect(logged).not.toContain(SECRET);
  });
});
