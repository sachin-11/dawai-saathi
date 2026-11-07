import type { PinoLogger } from 'nestjs-pino';

import type { AiClient } from '../ai-client/ai-client';
import { AiServiceError } from '../ai-client/ai-client.errors';
import type { ProcessRequest, ProcessResponse } from '../ai-client/types';
import type { StorageService } from '../common/storage/storage.service';
import type { MediaService } from '../messaging/media.service';
import type { MessagesService } from '../messaging/messages.service';
import type { WhatsAppClient } from '../messaging/whatsapp.client';
import type { InboundJobData } from '../queues/queue.constants';
import type { UserState, UsersService } from '../users/users.service';
import {
  AI_ERROR_REPLY_INDEX,
  AiProcessor,
  PRESIGNED_URL_TTL_SECONDS,
} from './ai-processor.service';
import type { ReplySession } from './replies.service';

const user: UserState = {
  id: 'user-1',
  language: 'hi',
  onboardingStep: 'done',
  consentAt: new Date(),
  remindersEnabled: true,
  deletedAt: null,
};

const job = (overrides: Partial<InboundJobData> = {}): InboundJobData => ({
  messageId: 'msg-1',
  userId: 'user-1',
  waMessageId: 'wamid.ABC123',
  type: 'text',
  receivedAt: new Date().toISOString(),
  requestId: 'req-1',
  ...overrides,
});

const aiReply = (overrides: Partial<ProcessResponse['reply']> = {}): ProcessResponse => ({
  request_id: 'wamid.ABC123',
  intent: 'help',
  emergency: false,
  extraction: null,
  warnings: [],
  reply: { language: 'hi', text: 'यह जवाब है', buttons: [], ...overrides },
  meta: {
    model: 'fake-model',
    prompt_version: 'v1',
    latency_ms: 20,
    cost_usd: 0.001,
    trace_id: 'trace-xyz',
    provider: 'fake',
    fallback_used: false,
  },
});

function setup(): {
  processor: AiProcessor;
  ai: { process: jest.Mock };
  messages: { findInboundForReply: jest.Mock };
  media: { storeInboundMedia: jest.Mock; maxMediaMb: number };
  storage: { getPresignedUrl: jest.Mock };
  users: { activeMedicationSalts: jest.Mock };
  whatsapp: { markAsRead: jest.Mock };
  logger: Record<'setContext' | 'info' | 'warn', jest.Mock>;
  calls: string[];
  session: Record<'text' | 'textAt' | 'rawText' | 'rawButtons', jest.Mock>;
} {
  const calls: string[] = [];
  const track = (name: string, value?: unknown): jest.Mock =>
    jest.fn().mockImplementation(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  const ai = { process: track('ai.process', aiReply()) };
  const messages = {
    findInboundForReply: jest.fn().mockResolvedValue({ bodyRedacted: 'kya kar sakte ho?' }),
  };
  const media = {
    storeInboundMedia: track('media.store', {
      status: 'stored',
      key: 'media/user-1/2026/11/msg-1.jpg',
      bytes: 2048,
      mimeType: 'image/jpeg',
    }),
    maxMediaMb: 10,
  };
  const storage = { getPresignedUrl: track('storage.presign', 'http://localhost:9000/b/k?sig=1') };
  const users = {
    activeMedicationSalts: jest
      .fn()
      .mockResolvedValue([{ salt: 'paracetamol', strength: '500 mg' }]),
  };
  const whatsapp = { markAsRead: track('whatsapp.markAsRead') };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const session = {
    text: track('session.text'),
    textAt: track('session.textAt'),
    rawText: track('session.rawText'),
    rawButtons: track('session.rawButtons'),
  };
  const processor = new AiProcessor(
    ai as unknown as AiClient,
    messages as unknown as MessagesService,
    media as unknown as MediaService,
    storage as unknown as StorageService,
    users as unknown as UsersService,
    whatsapp as unknown as WhatsAppClient,
    logger as unknown as PinoLogger,
  );
  return { processor, ai, messages, media, storage, users, whatsapp, logger, calls, session };
}
const asSession = (s: ReturnType<typeof setup>): ReplySession =>
  s.session as unknown as ReplySession;
const sentRequest = (s: ReturnType<typeof setup>): ProcessRequest =>
  s.ai.process.mock.calls[0]?.[0] as ProcessRequest;

describe('AiProcessor: text', () => {
  it('sends the REDACTED text from the database to the AI service with the right contract', async () => {
    const s = setup();
    await expect(s.processor.handle(user, job(), asSession(s))).resolves.toBe('ai_reply');

    expect(s.messages.findInboundForReply).toHaveBeenCalledWith('msg-1');
    expect(sentRequest(s)).toEqual({
      request_id: 'wamid.ABC123',
      user: { language: 'hi', age: null, sex: null },
      input: { type: 'text', text: 'kya kar sakte ho?' },
      context: { active_medications: [{ salt: 'paracetamol', strength: '500 mg' }] },
    });
  });

  it('does NOT send an acknowledgement, mark as read or touch media for text', async () => {
    const s = setup();
    await s.processor.handle(user, job(), asSession(s));
    expect(s.session.text).not.toHaveBeenCalled();
    expect(s.whatsapp.markAsRead).not.toHaveBeenCalled();
    expect(s.media.storeInboundMedia).not.toHaveBeenCalled();
    expect(s.storage.getPresignedUrl).not.toHaveBeenCalled();
  });

  it('sends the AI reply text through the outbound queue exactly once', async () => {
    const s = setup();
    await s.processor.handle(user, job(), asSession(s));
    expect(s.session.rawText).toHaveBeenCalledTimes(1);
    expect(s.session.rawText).toHaveBeenCalledWith('यह जवाब है');
    expect(s.session.rawButtons).not.toHaveBeenCalled();
  });

  it('sends buttons when the reply has them and the text fits a button message', async () => {
    const s = setup();
    const buttons = [{ id: 'set_reminders', title: 'Set reminders' }];
    s.ai.process.mockResolvedValue(aiReply({ buttons }));
    await s.processor.handle(user, job(), asSession(s));
    expect(s.session.rawButtons).toHaveBeenCalledWith('यह जवाब है', buttons);
    expect(s.session.rawText).not.toHaveBeenCalled();
  });

  it('falls back to plain text when the reply is too long for a button message (1024)', async () => {
    const s = setup();
    s.ai.process.mockResolvedValue(
      aiReply({ text: 'x'.repeat(1500), buttons: [{ id: 'a', title: 'A' }] }),
    );
    await s.processor.handle(user, job(), asSession(s));
    expect(s.session.rawText).toHaveBeenCalledWith('x'.repeat(1500));
    expect(s.session.rawButtons).not.toHaveBeenCalled();
  });

  it('treats a response without a buttons field as "no buttons"', async () => {
    const s = setup();
    const response = aiReply();
    delete (response.reply as { buttons?: unknown }).buttons;
    s.ai.process.mockResolvedValue(response);
    await s.processor.handle(user, job(), asSession(s));
    expect(s.session.rawText).toHaveBeenCalledTimes(1);
  });

  it('sanitises the WhatsApp message id into the request id', async () => {
    const s = setup();
    await s.processor.handle(user, job({ waMessageId: 'wamid.A B"C' }), asSession(s));
    expect(sentRequest(s).request_id).toBe('wamid.A_B_C');
  });

  it('an empty / missing stored text gets the polite "cannot read" reply instead of an AI call', async () => {
    const s = setup();
    s.messages.findInboundForReply.mockResolvedValue({ bodyRedacted: null });
    await expect(s.processor.handle(user, job(), asSession(s))).resolves.toBe('unsupported');
    expect(s.ai.process).not.toHaveBeenCalled();
    expect(s.session.text).toHaveBeenCalledWith('common.unsupported_type');
  });

  it.each(['unsupported', 'button'] as const)(
    'a %s message never reaches the AI service',
    async (type) => {
      const s = setup();
      await expect(s.processor.handle(user, job({ type }), asSession(s))).resolves.toBe(
        'unsupported',
      );
      expect(s.ai.process).not.toHaveBeenCalled();
      expect(s.session.text).toHaveBeenCalledWith('common.unsupported_type');
    },
  );
});

describe('AiProcessor: media', () => {
  const imageJob = (): InboundJobData =>
    job({ type: 'image', media: { id: 'media-1', mimeType: 'image/jpeg' } });

  it('acknowledges first (within seconds), then marks as read, stores the file, presigns, calls the AI', async () => {
    const s = setup();
    await expect(s.processor.handle(user, imageJob(), asSession(s))).resolves.toBe('ai_reply');

    expect(s.calls).toEqual([
      'session.text', // received_processing: the very first thing
      'whatsapp.markAsRead',
      'media.store',
      'storage.presign',
      'ai.process',
      'session.rawText',
    ]);
    expect(s.session.text).toHaveBeenCalledWith('common.received_processing');
    expect(s.storage.getPresignedUrl).toHaveBeenCalledWith(
      'media/user-1/2026/11/msg-1.jpg',
      PRESIGNED_URL_TTL_SECONDS,
    );
    expect(PRESIGNED_URL_TTL_SECONDS).toBe(300);
  });

  it('gives the AI service a presigned URL and the mime type, never the file or the S3 key', async () => {
    const s = setup();
    await s.processor.handle(user, imageJob(), asSession(s));
    expect(sentRequest(s).input).toEqual({
      type: 'image',
      media_url: 'http://localhost:9000/b/k?sig=1',
      mime: 'image/jpeg',
    });
    expect(JSON.stringify(sentRequest(s))).not.toContain('media/user-1');
  });

  it.each([
    ['document', 'application/pdf', 'image'],
    ['image', 'image/png', 'image'],
    ['audio', 'audio/ogg', 'audio'],
  ] as const)('a %s (%s) is sent as input type "%s"', async (type, mimeType, expected) => {
    const s = setup();
    s.media.storeInboundMedia.mockResolvedValue({ status: 'stored', key: 'k', bytes: 1, mimeType });
    await s.processor.handle(user, job({ type, media: { id: 'm', mimeType } }), asSession(s));
    expect(sentRequest(s).input).toMatchObject({ type: expected, mime: mimeType });
  });

  it('a media message keeps working when marking as read fails (blue ticks are a courtesy)', async () => {
    const s = setup();
    s.whatsapp.markAsRead.mockRejectedValue(new Error('meta down'));
    await expect(s.processor.handle(user, imageJob(), asSession(s))).resolves.toBe('ai_reply');
    expect(s.logger.warn).toHaveBeenCalled();
  });

  it('a file that is too large gets the size message (with the limit) and no AI call', async () => {
    const s = setup();
    s.media.storeInboundMedia.mockResolvedValue({ status: 'rejected', reason: 'too_large' });
    await expect(s.processor.handle(user, imageJob(), asSession(s))).resolves.toBe(
      'media_rejected',
    );
    expect(s.session.text).toHaveBeenCalledWith('common.file_too_large', { max_mb: 10 });
    expect(s.ai.process).not.toHaveBeenCalled();
    expect(s.storage.getPresignedUrl).not.toHaveBeenCalled();
  });

  it('a disallowed file type gets the polite reply and no AI call', async () => {
    const s = setup();
    s.media.storeInboundMedia.mockResolvedValue({ status: 'rejected', reason: 'unsupported_type' });
    await expect(s.processor.handle(user, imageJob(), asSession(s))).resolves.toBe(
      'media_rejected',
    );
    expect(s.session.text).toHaveBeenCalledWith('common.unsupported_type', {});
    expect(s.ai.process).not.toHaveBeenCalled();
  });

  it('a media job without a media id cannot be processed', async () => {
    const s = setup();
    await expect(s.processor.handle(user, job({ type: 'image' }), asSession(s))).resolves.toBe(
      'unsupported',
    );
    expect(s.ai.process).not.toHaveBeenCalled();
  });
});

describe('AiProcessor: failures', () => {
  const failure = new AiServiceError('server', 503, 'LLM_UNAVAILABLE');

  it('on an AI failure: ONE error message at a fixed reply index, then the error is rethrown for the retry policy', async () => {
    const s = setup();
    s.ai.process.mockRejectedValue(failure);
    await expect(s.processor.handle(user, job(), asSession(s))).rejects.toBe(failure);

    expect(s.session.textAt).toHaveBeenCalledTimes(1);
    expect(s.session.textAt).toHaveBeenCalledWith(AI_ERROR_REPLY_INDEX, 'common.error_try_again');
    expect(AI_ERROR_REPLY_INDEX).toBeGreaterThanOrEqual(90); // far from the normal 0, 1, 2 indices
    expect(s.session.rawText).not.toHaveBeenCalled();
  });

  it('retrying the job reuses the SAME error index, so the user can never get two error messages', async () => {
    const s = setup();
    s.ai.process.mockRejectedValue(failure);
    await s.processor.handle(user, job(), asSession(s)).catch(() => undefined);
    await s.processor.handle(user, job(), asSession(s)).catch(() => undefined);
    const indices = s.session.textAt.mock.calls.map((call) => call[0] as number);
    expect(new Set(indices).size).toBe(1);
  });

  it('a failure while storing media also gives one error message and rethrows', async () => {
    const s = setup();
    const boom = new Error('S3 unavailable');
    s.media.storeInboundMedia.mockRejectedValue(boom);
    await expect(
      s.processor.handle(
        user,
        job({ type: 'image', media: { id: 'm', mimeType: 'image/jpeg' } }),
        asSession(s),
      ),
    ).rejects.toBe(boom);
    expect(s.session.textAt).toHaveBeenCalledTimes(1);
    expect(s.ai.process).not.toHaveBeenCalled();
  });

  it('a failing error-message send does not hide the original error', async () => {
    const s = setup();
    s.ai.process.mockRejectedValue(failure);
    s.session.textAt.mockRejectedValue(new Error('outbound queue down'));
    await expect(s.processor.handle(user, job(), asSession(s))).rejects.toBe(failure);
  });
});

describe('AiProcessor: logging', () => {
  it('logs model, latency, cost, trace id and request id: never the text or the reply', async () => {
    const s = setup();
    await s.processor.handle(user, job(), asSession(s));
    const logged = JSON.stringify(s.logger.info.mock.calls);
    expect(logged).toContain('fake-model');
    expect(logged).toContain('trace-xyz');
    expect(logged).toContain('"latency_ms":20');
    expect(logged).toContain('"cost_usd":0.001');
    expect(logged).toContain('req-1');
    expect(logged).not.toContain('kya kar sakte');
    expect(logged).not.toContain('यह जवाब है');
  });
});
