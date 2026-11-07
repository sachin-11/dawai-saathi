import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { PinoLogger } from 'nestjs-pino';

import type { StorageService } from '../common/storage/storage.service';
import type { Env } from '../config/env.schema';
import {
  ALLOWED_MEDIA_TYPES,
  MediaIntegrityError,
  MediaService,
  buildMediaKey,
  createLimitedHashStream,
  normaliseMimeType,
} from './media.service';
import type { MessagesService } from './messages.service';
import type { WhatsAppClient } from './whatsapp.client';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const MB = 1024 * 1024;

interface Setup {
  service: MediaService;
  client: { getMediaUrl: jest.Mock; downloadMedia: jest.Mock };
  storage: { putStream: jest.Mock; deleteObject: jest.Mock };
  messages: { setMediaKey: jest.Mock };
  uploaded: Buffer[];
}

function setup(maxMb = 1): Setup {
  const uploaded: Buffer[] = [];
  const client = { getMediaUrl: jest.fn(), downloadMedia: jest.fn() };
  const storage = {
    // Behaves like the real upload: consumes the stream (so a size violation errors it).
    putStream: jest.fn(async ({ body }: { body: Readable }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      uploaded.push(Buffer.concat(chunks));
    }),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const messages = { setMediaKey: jest.fn().mockResolvedValue(undefined) };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const service = new MediaService(
    { MAX_MEDIA_MB: maxMb } as Env,
    client as unknown as WhatsAppClient,
    storage as unknown as StorageService,
    messages as unknown as MessagesService,
    logger as unknown as PinoLogger,
  );
  return { service, client, storage, messages, uploaded };
}

const store = (service: MediaService): ReturnType<MediaService['storeInboundMedia']> =>
  service.storeInboundMedia({ messageId: MESSAGE_ID, userId: USER_ID, mediaId: 'media-1' });

function mockDownload(
  s: Setup,
  content: Buffer,
  contentLength: number | undefined = content.length,
): void {
  s.client.downloadMedia.mockResolvedValue({
    stream: Readable.from([content]),
    contentLength,
    contentType: 'image/jpeg',
  });
}

describe('buildMediaKey', () => {
  it('is media/<userId>/<yyyy>/<mm>/<messageId>.<ext>', () => {
    expect(
      buildMediaKey({
        userId: USER_ID,
        messageId: MESSAGE_ID,
        extension: 'jpg',
        now: new Date('2026-03-05T10:00:00Z'),
      }),
    ).toBe(`media/${USER_ID}/2026/03/${MESSAGE_ID}.jpg`);
  });

  it('zero-pads the month and uses UTC', () => {
    const key = buildMediaKey({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      extension: 'pdf',
      now: new Date('2026-12-31T23:30:00Z'),
    });
    expect(key).toContain('/2026/12/');
  });

  it('contains only ids and a fixed extension: no phone number, no user filename', () => {
    const key = buildMediaKey({ userId: USER_ID, messageId: MESSAGE_ID, extension: 'jpg' });
    expect(key).toMatch(/^media\/[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,4}$/);
  });
});

describe('normaliseMimeType', () => {
  it.each([
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['IMAGE/JPEG', 'image/jpeg'],
    ['  application/pdf ', 'application/pdf'],
  ])('%s -> %s', (input, expected) => {
    expect(normaliseMimeType(input)).toBe(expected);
  });
});

describe('MediaService.storeInboundMedia', () => {
  describe('happy path', () => {
    it('downloads, uploads under a PII-free key, and records the key on the message', async () => {
      const s = setup();
      const content = Buffer.from('fake jpeg bytes');
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType: 'image/jpeg',
        fileSize: content.length,
        sha256: undefined,
      });
      mockDownload(s, content);

      const result = await store(s.service);

      expect(result.status).toBe('stored');
      if (result.status !== 'stored') return;
      expect(result.key).toMatch(
        new RegExp(`^media/${USER_ID}/\\d{4}/\\d{2}/${MESSAGE_ID}\\.jpg$`),
      );
      expect(result.bytes).toBe(content.length);
      expect(s.storage.putStream).toHaveBeenCalledWith(
        expect.objectContaining({ key: result.key, contentType: 'image/jpeg' }),
      );
      expect(s.uploaded[0]).toEqual(content);
      expect(s.messages.setMediaKey).toHaveBeenCalledWith(MESSAGE_ID, result.key);
    });

    it.each([...ALLOWED_MEDIA_TYPES.entries()])(
      'accepts %s (extension .%s)',
      async (mimeType, ext) => {
        const s = setup();
        s.client.getMediaUrl.mockResolvedValue({
          url: 'https://lookaside.fbsbx.com/x',
          mimeType,
          fileSize: 10,
        });
        mockDownload(s, Buffer.from('0123456789'));
        const result = await store(s.service);
        expect(result).toMatchObject({ status: 'stored', mimeType });
        expect((result as { key: string }).key.endsWith(`.${ext}`)).toBe(true);
      },
    );

    it('normalises the mime type of voice notes (audio/ogg; codecs=opus)', async () => {
      const s = setup();
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType: 'audio/ogg; codecs=opus',
        fileSize: 4,
      });
      mockDownload(s, Buffer.from('opus'));
      const result = await store(s.service);
      expect(result).toMatchObject({ status: 'stored', mimeType: 'audio/ogg' });
      expect(s.storage.putStream).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'audio/ogg' }),
      );
    });

    it('accepts a file of exactly the size limit', async () => {
      const s = setup(1);
      const content = Buffer.alloc(1 * MB, 1);
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType: 'image/png',
        fileSize: content.length,
      });
      mockDownload(s, content);
      expect((await store(s.service)).status).toBe('stored');
    });
  });

  describe('mime type allowlist', () => {
    it.each([
      'video/mp4',
      'application/zip',
      'text/html',
      'image/gif',
      'image/svg+xml', // can carry scripts
      'application/x-msdownload',
      'application/octet-stream',
      '',
    ])('rejects %p without downloading anything', async (mimeType) => {
      const s = setup();
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType,
        fileSize: 10,
      });
      await expect(store(s.service)).resolves.toEqual({
        status: 'rejected',
        reason: 'unsupported_type',
      });
      expect(s.client.downloadMedia).not.toHaveBeenCalled();
      expect(s.storage.putStream).not.toHaveBeenCalled();
      expect(s.messages.setMediaKey).not.toHaveBeenCalled();
    });
  });

  describe('size limit (MAX_MEDIA_MB)', () => {
    it('rejects, before downloading, when Meta reports a file size over the limit', async () => {
      const s = setup(1);
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType: 'image/jpeg',
        fileSize: 1 * MB + 1,
      });
      await expect(store(s.service)).resolves.toEqual({ status: 'rejected', reason: 'too_large' });
      expect(s.client.downloadMedia).not.toHaveBeenCalled();
    });

    it('rejects when the download Content-Length is over the limit, and drops the stream', async () => {
      const s = setup(1);
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType: 'image/jpeg',
        fileSize: undefined,
      });
      const stream = Readable.from([Buffer.from('x')]);
      s.client.downloadMedia.mockResolvedValue({
        stream,
        contentLength: 5 * MB,
        contentType: 'image/jpeg',
      });
      await expect(store(s.service)).resolves.toEqual({ status: 'rejected', reason: 'too_large' });
      expect(stream.destroyed).toBe(true);
      expect(s.storage.putStream).not.toHaveBeenCalled();
    });

    it('enforces the limit WHILE streaming when the size was not announced (or was a lie)', async () => {
      const s = setup(1);
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType: 'image/jpeg',
        fileSize: 100,
      });
      // claims to be tiny, actually sends 3 MB in 1 MB chunks
      const chunks = [Buffer.alloc(MB, 1), Buffer.alloc(MB, 2), Buffer.alloc(MB, 3)];
      s.client.downloadMedia.mockResolvedValue({
        stream: Readable.from(chunks),
        contentLength: 100,
        contentType: 'image/jpeg',
      });

      await expect(store(s.service)).resolves.toEqual({ status: 'rejected', reason: 'too_large' });
      expect(s.messages.setMediaKey).not.toHaveBeenCalled();
    });
  });

  describe('integrity (sha256)', () => {
    const content = Buffer.from('prescription image bytes');
    const hex = createHash('sha256').update(content).digest('hex');
    const base64 = createHash('sha256').update(content).digest('base64');

    it.each([
      ['hex', hex],
      ['base64', base64],
    ])('accepts a matching %s digest', async (_name, sha256) => {
      const s = setup();
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType: 'image/jpeg',
        fileSize: content.length,
        sha256,
      });
      mockDownload(s, content);
      expect((await store(s.service)).status).toBe('stored');
      expect(s.storage.deleteObject).not.toHaveBeenCalled();
    });

    it('deletes the stored object and throws when the digest does not match', async () => {
      const s = setup();
      s.client.getMediaUrl.mockResolvedValue({
        url: 'https://lookaside.fbsbx.com/x',
        mimeType: 'image/jpeg',
        fileSize: content.length,
        sha256: 'deadbeef',
      });
      mockDownload(s, content);
      await expect(store(s.service)).rejects.toBeInstanceOf(MediaIntegrityError);
      expect(s.storage.deleteObject).toHaveBeenCalledTimes(1);
      expect(s.messages.setMediaKey).not.toHaveBeenCalled();
    });
  });

  it('propagates infrastructure failures so the job is retried', async () => {
    const s = setup();
    s.client.getMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/x',
      mimeType: 'image/jpeg',
      fileSize: 5,
    });
    mockDownload(s, Buffer.from('12345'));
    s.storage.putStream.mockRejectedValue(new Error('S3 unavailable'));
    await expect(store(s.service)).rejects.toThrow('S3 unavailable');
    expect(s.messages.setMediaKey).not.toHaveBeenCalled();
  });

  it('propagates a failure of the media lookup (e.g. an expired media id)', async () => {
    const s = setup();
    s.client.getMediaUrl.mockRejectedValue(new Error('Graph API error'));
    await expect(store(s.service)).rejects.toThrow('Graph API error');
  });
});

describe('createLimitedHashStream', () => {
  it('counts bytes and hashes what passes through', async () => {
    const guard = createLimitedHashStream(100);
    Readable.from([Buffer.from('abc'), Buffer.from('def')]).pipe(guard.stream);
    await guard.stream.toArray(); // drain
    expect(guard.bytes()).toBe(6);
    expect(guard.digest().hex).toBe(createHash('sha256').update('abcdef').digest('hex'));
    expect(guard.exceeded()).toBe(false);
  });

  it('errors and flags `exceeded` once the limit is crossed', async () => {
    const guard = createLimitedHashStream(5);
    Readable.from([Buffer.from('abc'), Buffer.from('def')]).pipe(guard.stream);
    await expect(guard.stream.toArray()).rejects.toThrow(/size limit/);
    expect(guard.exceeded()).toBe(true);
  });
});
