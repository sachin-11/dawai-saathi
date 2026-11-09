import nock from 'nock';
import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../config/env.schema';
import { WhatsAppApiError, WhatsAppValidationError } from './whatsapp.errors';
import { WhatsAppClient, isAllowedMediaUrl, MAX_INTERACTIVE_BODY_LENGTH } from './whatsapp.client';
import { DEFAULT_RETRY_POLICY } from './whatsapp.retry';

const TOKEN = 'SECRET-TOKEN-xyz-123';
const PHONE = '919999999999';
const PHONE_NUMBER_ID = '100000000000001';
const GRAPH = 'https://graph.facebook.com';
const SEND_PATH = `/v21.0/${PHONE_NUMBER_ID}/messages`;

const env = {
  WA_ACCESS_TOKEN: TOKEN,
  WA_API_BASE_URL: GRAPH,
  WA_API_VERSION: 'v21.0',
  WA_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
} as Env;

function setup(): {
  client: WhatsAppClient;
  logger: Record<'setContext' | 'info' | 'warn' | 'error', jest.Mock>;
  sleep: jest.Mock;
} {
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = new WhatsAppClient(env, logger as unknown as PinoLogger);
  const sleep = jest.fn().mockResolvedValue(undefined);
  client.retryPolicy = { ...DEFAULT_RETRY_POLICY, sleep, random: () => 0.5 };
  return { client, logger, sleep };
}

const ok = (id = 'wamid.OUT1'): { messages: { id: string }[] } => ({ messages: [{ id }] });
const graphError = (code: number, message = 'boom'): object => ({
  error: { message, type: 'OAuthException', code, fbtrace_id: 'abc' },
});

describe('WhatsAppClient', () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    const pending = nock.pendingMocks();
    nock.cleanAll(); // always clean first so one failure cannot leak mocks into the next test
    expect(pending).toEqual([]);
  });
  afterAll(() => {
    nock.enableNetConnect();
  });

  describe('request shapes', () => {
    it('sendText posts the expected body with bearer auth and returns the wamid', async () => {
      const { client } = setup();
      nock(GRAPH)
        .post(SEND_PATH, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: PHONE,
          type: 'text',
          text: { body: 'hello', preview_url: false },
        })
        .matchHeader('authorization', `Bearer ${TOKEN}`)
        .matchHeader('content-type', /application\/json/)
        .reply(200, ok('wamid.A'));

      await expect(client.sendText(PHONE, 'hello')).resolves.toEqual({ waMessageId: 'wamid.A' });
    });

    it('sendText supports previewUrl', async () => {
      const { client } = setup();
      nock(GRAPH)
        .post(SEND_PATH, (body: { text: { preview_url: boolean } }) => body.text.preview_url)
        .reply(200, ok());
      await client.sendText(PHONE, 'see https://example.com', { previewUrl: true });
    });

    it('sendButtons posts an interactive reply-button message', async () => {
      const { client } = setup();
      nock(GRAPH)
        .post(SEND_PATH, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: PHONE,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: 'Do you agree?' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'yes', title: 'I agree' } },
                { type: 'reply', reply: { id: 'no', title: 'Not now' } },
              ],
            },
          },
        })
        .reply(200, ok());
      await client.sendButtons(PHONE, 'Do you agree?', [
        { id: 'yes', title: 'I agree' },
        { id: 'no', title: 'Not now' },
      ]);
    });

    it('sendTemplate posts name, language and components', async () => {
      const { client } = setup();
      const components = [
        { type: 'body' as const, parameters: [{ type: 'text' as const, text: 'Dolo 650' }] },
        {
          type: 'button' as const,
          sub_type: 'quick_reply' as const,
          index: '0',
          parameters: [{ type: 'payload' as const, payload: 'taken:abc' }],
        },
      ];
      nock(GRAPH)
        .post(SEND_PATH, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: PHONE,
          type: 'template',
          template: { name: 'dose_reminder', language: { code: 'hi' }, components },
        })
        .reply(200, ok());
      await client.sendTemplate(PHONE, 'dose_reminder', 'hi', components);
    });

    it('markAsRead posts a read receipt for the message id', async () => {
      const { client } = setup();
      nock(GRAPH)
        .post(SEND_PATH, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1' })
        .reply(200, { success: true });
      await expect(client.markAsRead('wamid.IN1')).resolves.toBeUndefined();
    });

    it('getMediaUrl returns url, mime type, size and sha256', async () => {
      const { client } = setup();
      nock(GRAPH)
        .get('/v21.0/media-123')
        .matchHeader('authorization', `Bearer ${TOKEN}`)
        .reply(200, {
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
          mime_type: 'image/jpeg',
          file_size: 2048,
          sha256: 'abc',
          id: 'media-123',
        });
      await expect(client.getMediaUrl('media-123')).resolves.toEqual({
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
        mimeType: 'image/jpeg',
        fileSize: 2048,
        sha256: 'abc',
      });
    });

    it('downloadMedia streams the file with the bearer token', async () => {
      const { client } = setup();
      const content = Buffer.from('fake-image-bytes');
      nock('https://lookaside.fbsbx.com')
        .get('/whatsapp_business/attachments/')
        .query({ mid: '1' })
        .matchHeader('authorization', `Bearer ${TOKEN}`)
        .reply(200, content, {
          'content-type': 'image/jpeg',
          'content-length': String(content.length),
        });

      const download = await client.downloadMedia(
        'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
      );
      const chunks: Buffer[] = [];
      for await (const chunk of download.stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks)).toEqual(content);
      expect(download.contentLength).toBe(content.length);
      expect(download.contentType).toBe('image/jpeg');
    });
  });

  describe('voice replies (M13)', () => {
    it('uploadMedia posts multipart to /media with the bearer token and returns the media id', async () => {
      const { client } = setup();
      let body = '';
      nock(GRAPH, { reqheaders: { authorization: `Bearer ${TOKEN}` } })
        .post(`/v21.0/${PHONE_NUMBER_ID}/media`, (b: unknown) => {
          body = String(b);
          return true;
        })
        .reply(200, { id: 'MEDIA-123' });
      const result = await client.uploadMedia(Buffer.from('OggS-fake-bytes'), 'audio/ogg');
      expect(result).toEqual({ mediaId: 'MEDIA-123' });
      expect(body).toContain('messaging_product');
      expect(body).toContain('audio/ogg');
    });

    it('uploadMedia is retried after a server error (an upload creates no message)', async () => {
      const { client, sleep } = setup();
      nock(GRAPH)
        .post(`/v21.0/${PHONE_NUMBER_ID}/media`)
        .reply(503, graphError(2))
        .post(`/v21.0/${PHONE_NUMBER_ID}/media`)
        .reply(200, { id: 'MEDIA-9' });
      await expect(client.uploadMedia(Buffer.from('x'), 'audio/ogg')).resolves.toEqual({
        mediaId: 'MEDIA-9',
      });
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('uploadMedia refuses an empty or oversized file without any HTTP call', async () => {
      const { client } = setup();
      await expect(client.uploadMedia(Buffer.alloc(0), 'audio/ogg')).rejects.toBeInstanceOf(
        WhatsAppValidationError,
      );
      await expect(
        client.uploadMedia(Buffer.alloc(17 * 1024 * 1024), 'audio/ogg'),
      ).rejects.toBeInstanceOf(WhatsAppValidationError);
    });

    it('sendAudio posts an audio message by media id', async () => {
      const { client } = setup();
      let sent: unknown;
      nock(GRAPH)
        .post(SEND_PATH, (b: unknown) => {
          sent = b;
          return true;
        })
        .reply(200, ok('wamid.AUDIO1'));
      await expect(client.sendAudio(PHONE, 'MEDIA-123')).resolves.toEqual({
        waMessageId: 'wamid.AUDIO1',
      });
      expect(sent).toMatchObject({
        messaging_product: 'whatsapp',
        to: PHONE,
        type: 'audio',
        audio: { id: 'MEDIA-123' },
      });
    });

    it('sendAudio is not retried after an ambiguous timeout (it would play twice)', () => {
      const { client } = setup();
      expect(() => client.sendAudio(PHONE, 'bad id!')).toThrow(WhatsAppValidationError);
    });
  });

  describe('client-side validation (no HTTP call is made)', () => {
    it('rejects an empty text', () => {
      expect(() => setup().client.sendText(PHONE, '   ')).toThrow(WhatsAppValidationError);
    });

    it('rejects text over 4096 characters', () => {
      expect(() => setup().client.sendText(PHONE, 'x'.repeat(4097))).toThrow(/4096/);
    });

    it('accepts exactly 4096 characters', async () => {
      const { client } = setup();
      nock(GRAPH).post(SEND_PATH).reply(200, ok());
      await client.sendText(PHONE, 'x'.repeat(4096));
    });

    it('rejects 4 buttons (WhatsApp allows at most 3)', () => {
      const buttons = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id }));
      expect(() => setup().client.sendButtons(PHONE, 'pick', buttons)).toThrow(/1–3 buttons/);
    });

    it('rejects zero buttons', () => {
      expect(() => setup().client.sendButtons(PHONE, 'pick', [])).toThrow(WhatsAppValidationError);
    });

    it('rejects a button title over 20 characters', () => {
      expect(() =>
        setup().client.sendButtons(PHONE, 'pick', [{ id: 'a', title: 'x'.repeat(21) }]),
      ).toThrow(/title/);
    });

    it('accepts a 20-character title', async () => {
      const { client } = setup();
      nock(GRAPH).post(SEND_PATH).reply(200, ok());
      await client.sendButtons(PHONE, 'pick', [{ id: 'a', title: 'x'.repeat(20) }]);
    });

    it('rejects a button id over 256 characters', () => {
      expect(() =>
        setup().client.sendButtons(PHONE, 'pick', [{ id: 'x'.repeat(257), title: 'ok' }]),
      ).toThrow(/id/);
    });

    it('rejects duplicate button ids', () => {
      expect(() =>
        setup().client.sendButtons(PHONE, 'pick', [
          { id: 'a', title: 'one' },
          { id: 'a', title: 'two' },
        ]),
      ).toThrow(/unique/);
    });

    it('rejects an interactive body over the WhatsApp limit', () => {
      expect(() =>
        setup().client.sendButtons(PHONE, 'x'.repeat(MAX_INTERACTIVE_BODY_LENGTH + 1), [
          { id: 'a', title: 'ok' },
        ]),
      ).toThrow(WhatsAppValidationError);
    });

    it('rejects a media id that is not a plain identifier (no path tricks)', async () => {
      await expect(setup().client.getMediaUrl('../../etc')).rejects.toThrow(
        WhatsAppValidationError,
      );
    });
  });

  describe('media url safety (the bearer token must only reach Meta hosts)', () => {
    it.each([
      'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
      'https://scontent.whatsapp.net/v/t61/file.jpg',
      'https://example.fbcdn.net/x',
      'https://graph.facebook.com/media/1',
    ])('allows %s', (url) => {
      expect(isAllowedMediaUrl(url)).toBe(true);
    });

    it.each([
      'http://lookaside.fbsbx.com/x', // not HTTPS
      'https://evil.example.com/fbsbx.com',
      'https://fbsbx.com.evil.com/x',
      'https://evilfbsbx.com/x', // suffix without the dot boundary
      'ftp://lookaside.fbsbx.com/x',
      'not a url',
      'https://127.0.0.1/x',
    ])('rejects %s', (url) => {
      expect(isAllowedMediaUrl(url)).toBe(false);
    });

    it('downloadMedia refuses a disallowed host without any request', () => {
      expect(() => setup().client.downloadMedia('https://evil.example.com/a')).toThrow(
        WhatsAppValidationError,
      );
    });
  });

  describe('retries', () => {
    it('retries 5xx with backoff and succeeds', async () => {
      const { client, sleep } = setup();
      nock(GRAPH)
        .post(SEND_PATH)
        .reply(503, graphError(2))
        .post(SEND_PATH)
        .reply(500, graphError(1))
        .post(SEND_PATH)
        .reply(200, ok('wamid.OK'));

      await expect(client.sendText(PHONE, 'hi')).resolves.toEqual({ waMessageId: 'wamid.OK' });
      expect(sleep).toHaveBeenCalledTimes(2);
      // exponential: the second wait is longer than the first
      expect(sleep.mock.calls[1]?.[0]).toBeGreaterThan(sleep.mock.calls[0]?.[0] as number);
    });

    it('retries HTTP 429, honouring Retry-After when it is longer', async () => {
      const { client, sleep } = setup();
      nock(GRAPH)
        .post(SEND_PATH)
        .reply(429, graphError(4), { 'retry-after': '20' })
        .post(SEND_PATH)
        .reply(200, ok());
      await client.sendText(PHONE, 'hi');
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(20_000);
    });

    it('gives up after 4 attempts and throws a retryable server error', async () => {
      const { client, sleep } = setup();
      nock(GRAPH).post(SEND_PATH).times(4).reply(502, graphError(2));
      const error = await client.sendText(PHONE, 'hi').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WhatsAppApiError);
      expect(error).toMatchObject({ kind: 'server', retryable: true, httpStatus: 502 });
      expect(sleep).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry a 400', async () => {
      const { client, sleep } = setup();
      nock(GRAPH).post(SEND_PATH).reply(400, graphError(100, 'Invalid parameter'));
      await expect(client.sendText(PHONE, 'hi')).rejects.toMatchObject({
        kind: 'client',
        retryable: false,
        code: 100,
      });
      expect(sleep).not.toHaveBeenCalled();
    });

    it('retries a connection failure on a send (the request never reached Meta)', async () => {
      const { client, sleep } = setup();
      nock(GRAPH)
        .post(SEND_PATH)
        .replyWithError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })
        .post(SEND_PATH)
        .reply(200, ok('wamid.AFTER'));
      await expect(client.sendText(PHONE, 'hi')).resolves.toEqual({ waMessageId: 'wamid.AFTER' });
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a send that failed after the request was on the wire (could double-send)', async () => {
      const { client, sleep } = setup();
      nock(GRAPH).post(SEND_PATH).replyWithError({ code: 'ECONNRESET', message: 'socket hang up' });
      await expect(client.sendText(PHONE, 'hi')).rejects.toMatchObject({
        kind: 'network',
        retryable: true, // the QUEUE may retry; the client itself must not
      });
      expect(sleep).not.toHaveBeenCalled();
    });

    it('DOES retry the same ambiguous failure on idempotent calls (markAsRead)', async () => {
      const { client, sleep } = setup();
      nock(GRAPH)
        .post(SEND_PATH)
        .replyWithError({ code: 'ECONNRESET', message: 'socket hang up' })
        .post(SEND_PATH)
        .reply(200, { success: true });
      await client.markAsRead('wamid.IN1');
      expect(sleep).toHaveBeenCalledTimes(1);
    });
  });

  describe('Meta error mapping', () => {
    it('131047 (re-engagement) -> window_closed, not retryable, not retried', async () => {
      const { client, sleep } = setup();
      nock(GRAPH).post(SEND_PATH).reply(400, graphError(131047, 'Re-engagement message'));
      await expect(client.sendText(PHONE, 'hi')).rejects.toMatchObject({
        kind: 'window_closed',
        retryable: false,
        code: 131047,
        httpStatus: 400,
      });
      expect(sleep).not.toHaveBeenCalled();
    });

    it('131026 (undeliverable) -> not retryable', async () => {
      const { client } = setup();
      nock(GRAPH).post(SEND_PATH).reply(400, graphError(131026, 'Message undeliverable'));
      await expect(client.sendText(PHONE, 'hi')).rejects.toMatchObject({
        kind: 'undeliverable',
        retryable: false,
        code: 131026,
      });
    });

    it.each([130429, 131056])(
      '%s (rate limit) -> retryable, and left to the queue (long backoff), not retried in-request',
      async (code) => {
        const { client, sleep } = setup();
        nock(GRAPH).post(SEND_PATH).reply(400, graphError(code, 'Rate limit hit'));
        await expect(client.sendText(PHONE, 'hi')).rejects.toMatchObject({
          kind: 'rate_limit',
          retryable: true,
          code,
        });
        expect(sleep).not.toHaveBeenCalled();
      },
    );

    it('190 (invalid token) -> auth, not retryable, logged at error level without the token', async () => {
      const { client, logger, sleep } = setup();
      nock(GRAPH)
        .post(SEND_PATH)
        .reply(401, graphError(190, `Invalid OAuth access token ${TOKEN}`));
      await expect(client.sendText(PHONE, 'hi')).rejects.toMatchObject({
        kind: 'auth',
        retryable: false,
        code: 190,
      });
      expect(sleep).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
    });

    it('exposes the Meta subcode when present', async () => {
      const { client } = setup();
      nock(GRAPH)
        .post(SEND_PATH)
        .reply(400, { error: { message: 'x', code: 100, error_subcode: 2018001 } });
      await expect(client.sendText(PHONE, 'hi')).rejects.toMatchObject({ subcode: 2018001 });
    });

    it('treats a 200 with an unreadable body as non-retryable (resending would duplicate)', async () => {
      const { client } = setup();
      nock(GRAPH).post(SEND_PATH).reply(200, {});
      await expect(client.sendText(PHONE, 'hi')).rejects.toMatchObject({
        kind: 'invalid_response',
        retryable: false,
      });
    });

    it('redacts phone numbers in error messages', async () => {
      const { client } = setup();
      nock(GRAPH)
        .post(SEND_PATH)
        .reply(400, graphError(131030, 'Recipient 9876543210 is not in the allowed list'));
      const error = (await client.sendText(PHONE, 'hi').catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain('9876543210');
      expect(error.message).toContain('[REDACTED_PHONE]');
    });
  });

  describe('logging', () => {
    it('never logs the token, phone numbers or message bodies', async () => {
      const { client, logger } = setup();
      const body = 'Meri dawai Dolo 650 ke baare me batao';
      nock(GRAPH)
        .post(SEND_PATH)
        .reply(500, graphError(2, `failed for ${PHONE}`))
        .post(SEND_PATH)
        .reply(200, ok());
      await client.sendText(PHONE, body, { requestId: 'req-1' });

      const everyLogCall: unknown[] = [
        logger.info.mock.calls,
        logger.warn.mock.calls,
        logger.error.mock.calls,
      ];
      const logged = JSON.stringify(everyLogCall);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(PHONE);
      expect(logged).not.toContain('Dolo');
      expect(logged).toContain('req-1');
      expect(logger.info.mock.calls[0]?.[0]).toMatchObject({
        operation: 'messages.send',
        status: 500,
        meta_code: 2,
        attempt: 1,
        request_id: 'req-1',
      });
      expect(typeof (logger.info.mock.calls[0]?.[0] as { latency_ms: unknown }).latency_ms).toBe(
        'number',
      );
    });
  });
});
