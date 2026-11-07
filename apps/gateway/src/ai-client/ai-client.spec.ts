import nock from 'nock';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../config/env.schema';
import { AiClient, DEFAULT_AI_RETRY_POLICY, toRequestId } from './ai-client';
import { AiServiceError } from './ai-client.errors';
import type { ProcessRequest, ProcessResponse } from './types';

const BASE = 'http://ai.test:8000';
const TOKEN = 'service-token-secret-123';

function setup(timeoutMs = 70_000): {
  client: AiClient;
  logger: Record<'setContext' | 'info', jest.Mock>;
  sleep: jest.Mock;
} {
  const logger = { setContext: jest.fn(), info: jest.fn() };
  const env = {
    AI_SERVICE_URL: `${BASE}/`, // trailing slash on purpose
    SERVICE_TOKEN: TOKEN,
    AI_CLIENT_TIMEOUT_MS: timeoutMs,
  } as Env;
  const client = new AiClient(env, logger as unknown as PinoLogger);
  const sleep = jest.fn().mockResolvedValue(undefined);
  client.retryPolicy = { ...DEFAULT_AI_RETRY_POLICY, sleep, random: () => 0.5 };
  return { client, logger, sleep };
}

const request: ProcessRequest = {
  request_id: 'wamid.HBgLOTE5ODc2',
  user: { language: 'hi', age: null, sex: null },
  input: { type: 'text', text: 'kya kar sakte ho? mera number [REDACTED_PHONE]' },
  context: { active_medications: [{ salt: 'paracetamol', strength: '500 mg' }] },
};

const reply: ProcessResponse = {
  request_id: request.request_id,
  intent: 'help',
  emergency: false,
  extraction: null,
  warnings: [],
  reply: { language: 'hi', text: 'मैं दवाई साथी हूँ', buttons: [] },
  meta: {
    model: 'fake-model',
    prompt_version: 'intent_text_v1',
    latency_ms: 12,
    cost_usd: 0,
    trace_id: null,
    provider: 'fake',
    fallback_used: false,
  },
};

const errorBody = (status: number, code: string): object => ({
  error: { status, code, message: 'boom with user text 9876543210', request_id: 'x' },
});

describe('AiClient', () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    const pending = nock.pendingMocks();
    nock.cleanAll();
    expect(pending).toEqual([]);
  });
  afterAll(() => {
    nock.enableNetConnect();
  });

  it('POSTs the contract body with the service token and a request id header', async () => {
    const { client } = setup();
    nock(BASE)
      .post('/v1/process', (body) => JSON.stringify(body) === JSON.stringify(request))
      .matchHeader('x-service-token', TOKEN)
      .matchHeader('content-type', /application\/json/)
      .matchHeader('x-request-id', request.request_id)
      .reply(200, reply);
    await expect(client.process(request)).resolves.toEqual(reply);
  });

  it('sanitises the request id header and the contract field', () => {
    expect(toRequestId('wamid.AB+/=-_')).toBe('wamid.AB+/=-_');
    expect(toRequestId('has space\nand"quotes')).toBe('has_space_and_quotes');
    expect(toRequestId('x'.repeat(300))).toHaveLength(200);
    expect(toRequestId('')).toBe('unknown');
  });

  describe('retries (the call is idempotent by request_id)', () => {
    it('retries a 5xx once and succeeds', async () => {
      const { client, sleep } = setup();
      nock(BASE)
        .post('/v1/process')
        .reply(503, errorBody(503, 'LLM_UNAVAILABLE'))
        .post('/v1/process')
        .reply(200, reply);
      await expect(client.process(request)).resolves.toEqual(reply);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('gives up after the second 5xx with a typed error carrying the AI service code', async () => {
      const { client } = setup();
      nock(BASE).post('/v1/process').times(2).reply(503, errorBody(503, 'LLM_UNAVAILABLE'));
      const error = await client.process(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiServiceError);
      expect(error).toMatchObject({ kind: 'server', status: 503, code: 'LLM_UNAVAILABLE' });
    });

    it('retries a connection error and succeeds', async () => {
      const { client, sleep } = setup();
      nock(BASE)
        .post('/v1/process')
        .replyWithError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })
        .post('/v1/process')
        .reply(200, reply);
      await expect(client.process(request)).resolves.toEqual(reply);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('a connection error on every attempt becomes a "connection" AiServiceError', async () => {
      const { client } = setup();
      nock(BASE)
        .post('/v1/process')
        .times(2)
        .replyWithError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
      await expect(client.process(request)).rejects.toMatchObject({ kind: 'connection' });
    });

    it.each([400, 401, 403, 413, 422])('does NOT retry HTTP %s', async (status) => {
      const { client, sleep } = setup();
      nock(BASE).post('/v1/process').reply(status, errorBody(status, 'SOME_CODE'));
      const error = await client.process(request).catch((e: unknown) => e);
      expect(error).toMatchObject({ status, kind: status === 401 ? 'unauthorized' : 'client' });
      expect(sleep).not.toHaveBeenCalled();
    });

    it('does NOT retry a 504: the AI service already used its whole time budget', async () => {
      const { client, sleep } = setup();
      nock(BASE).post('/v1/process').reply(504, errorBody(504, 'PROCESS_TIMEOUT'));
      await expect(client.process(request)).rejects.toMatchObject({
        kind: 'server',
        status: 504,
        code: 'PROCESS_TIMEOUT',
      });
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  it('times out after AI_CLIENT_TIMEOUT_MS and does not retry', async () => {
    const { client, sleep } = setup(50);
    nock(BASE).post('/v1/process').delay(600).reply(200, reply);
    await expect(client.process(request)).rejects.toMatchObject({ kind: 'timeout' });
    expect(sleep).not.toHaveBeenCalled();
    nock.cleanAll();
  });

  it('rejects a 200 whose body is not a usable response', async () => {
    const { client } = setup();
    nock(BASE).post('/v1/process').reply(200, { hello: 'world' });
    await expect(client.process(request)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects a 200 that is not JSON', async () => {
    const { client } = setup();
    nock(BASE).post('/v1/process').reply(200, 'not json', { 'content-type': 'text/plain' });
    await expect(client.process(request)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('the error message never carries the AI service body (it could echo user data)', async () => {
    const { client } = setup();
    nock(BASE).post('/v1/process').reply(422, errorBody(422, 'UNPROCESSABLE_CONTENT'));
    const error = (await client.process(request).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('9876543210');
    expect(error.message).not.toContain('boom');
  });

  it('logs operation, status, latency and request id: never the text, the reply or the token', async () => {
    const { client, logger } = setup();
    nock(BASE).post('/v1/process').reply(200, reply);
    await client.process(request);
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).toContain('ai.process');
    expect(logged).toContain(request.request_id);
    expect(logged).not.toContain('kya kar sakte');
    expect(logged).not.toContain('दवाई साथी');
    expect(logged).not.toContain(TOKEN);
  });

  it('works with a base URL that has a trailing slash', async () => {
    const { client } = setup();
    nock(BASE).post('/v1/process').reply(200, reply);
    await expect(client.process(request)).resolves.toBeDefined();
  });
});
