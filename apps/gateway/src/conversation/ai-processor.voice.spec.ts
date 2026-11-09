import type { AuditService } from '../audit/audit.service';
import type { AiClient } from '../ai-client/ai-client';
import type { ProcessResponse } from '../ai-client/types';
import type { StorageService } from '../common/storage/storage.service';
import type { LabReportService } from '../documents/lab-report.service';
import type { PrescriptionService } from '../documents/prescription.service';
import type { MediaService } from '../messaging/media.service';
import type { MessagesService } from '../messaging/messages.service';
import type { WhatsAppClient } from '../messaging/whatsapp.client';
import type { PinoLogger } from 'nestjs-pino';
import type { InboundJobData } from '../queues/queue.constants';
import type { UserState } from '../users/users.service';
import { BudgetService } from '../limits/budget.service';
import { RateLimitService } from '../limits/rate-limit.service';
import { AiProcessor, LISTENING_ACK_MIN_BYTES } from './ai-processor.service';
import type { InteractionFlowService } from './interaction-flow.service';
import type { ReplySession } from './replies.service';

const user = (overrides: Partial<UserState> = {}): UserState => ({
  id: 'user-1',
  language: 'hi',
  onboardingStep: 'done',
  consentAt: new Date(),
  remindersEnabled: true,
  consentVersion: 'v2',
  voiceReplies: false,
  deletedAt: null,
  ...overrides,
});

const voiceJob = (overrides: Partial<InboundJobData> = {}): InboundJobData => ({
  messageId: 'msg-1',
  userId: 'user-1',
  waMessageId: 'wamid.VOICE1',
  type: 'audio',
  media: { id: 'media-1', mimeType: 'audio/ogg; codecs=opus' },
  receivedAt: new Date().toISOString(),
  requestId: 'req-1',
  ...overrides,
});

const response = (overrides: Partial<ProcessResponse> = {}): ProcessResponse => ({
  request_id: 'wamid.VOICE1',
  intent: 'interaction_query',
  emergency: false,
  extraction: null,
  warnings: [],
  reply: { language: 'hi', text: 'जवाब', buttons: [] },
  meta: {
    model: 'fake-model',
    prompt_version: 'v1',
    latency_ms: 5,
    cost_usd: 0,
    trace_id: 't',
    provider: 'fake',
    fallback_used: false,
  },
  ...overrides,
});

function setup(options: { tts?: boolean; bytes?: number } = {}) {
  const calls: string[] = [];
  const track = (name: string, value?: unknown): jest.Mock =>
    jest.fn().mockImplementation(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  const ai = {
    process: track('ai.process', response()),
    synthesize: track('ai.synthesize', {
      request_id: 'r',
      audio_base64: Buffer.from('OggS-bytes').toString('base64'),
      mime: 'audio/ogg',
      duration_s: 3,
    }),
  };
  const media = {
    storeInboundMedia: track('media.store', {
      status: 'stored',
      key: 'media/user-1/2026/11/msg-1.ogg',
      bytes: options.bytes ?? 5_000,
      mimeType: 'audio/ogg',
    }),
    maxMediaMb: 10,
  };
  const storage = { getPresignedUrl: track('storage.presign', 'http://localhost:9000/b/k?sig=1') };
  const users = { activeMedicationSalts: jest.fn().mockResolvedValue([]) };
  const whatsapp = {
    markAsRead: track('whatsapp.markAsRead'),
    uploadMedia: track('whatsapp.uploadMedia', { mediaId: 'MEDIA42' }),
  };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const session = {
    text: track('session.text'),
    textAt: track('session.textAt'),
    buttons: track('session.buttons'),
    rawText: track('session.rawText'),
    rawButtons: track('session.rawButtons'),
    rawButtonsWithPrompt: track('session.rawButtonsWithPrompt'),
    rawEmergencyText: track('session.rawEmergencyText'),
    rawAudio: track('session.rawAudio'),
    markIntent: jest.fn(),
  };
  const processor = new AiProcessor(
    ai as unknown as AiClient,
    { findInboundForReply: jest.fn() } as unknown as MessagesService,
    media as unknown as MediaService,
    storage as unknown as StorageService,
    users as never,
    whatsapp as unknown as WhatsAppClient,
    { log: jest.fn() } as unknown as AuditService,
    { save: jest.fn() } as unknown as PrescriptionService,
    {
      save: jest.fn(),
      previousResults: jest.fn().mockResolvedValue([]),
    } as unknown as LabReportService,
    { offerDetails: jest.fn() } as unknown as InteractionFlowService,
    {
      userOverCap: jest.fn().mockResolvedValue(false),
      snapshot: jest.fn().mockResolvedValue({ state: 'normal', spentUsd: 0, ratio: 0 }),
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as BudgetService,
    { costCapNotice: jest.fn().mockResolvedValue(true) } as unknown as RateLimitService,
    logger as unknown as PinoLogger,
    { TTS_ENABLED: options.tts ?? false },
  );
  return {
    processor,
    ai,
    media,
    whatsapp,
    session,
    calls,
    asSession: session as unknown as ReplySession,
  };
}

describe('AiProcessor: voice notes (M13)', () => {
  it('sends the audio as input type audio with a presigned URL and the mime type', async () => {
    const s = setup();
    await s.processor.handle(user(), voiceJob(), s.asSession);
    const request = s.ai.process.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(request.input).toMatchObject({ type: 'audio', mime: 'audio/ogg' });
    expect(String(request.input.media_url)).toContain('localhost:9000');
    expect(JSON.stringify(request)).not.toContain('OggS');
  });

  it('a user on the old consent text gets the one-time notice and NOTHING is downloaded or sent', async () => {
    const s = setup();
    const outcome = await s.processor.handle(
      user({ consentVersion: 'v1' }),
      voiceJob(),
      s.asSession,
    );
    expect(outcome).toBe('voice_notice');
    expect(s.session.buttons).toHaveBeenCalledWith(
      'voice.notice',
      {},
      expect.arrayContaining([expect.objectContaining({ id: 'voice:ok' })]),
    );
    expect(s.media.storeInboundMedia).not.toHaveBeenCalled();
    expect(s.ai.process).not.toHaveBeenCalled();
  });

  it('a user with no consent version at all is treated the same', async () => {
    const s = setup();
    const outcome = await s.processor.handle(
      user({ consentVersion: null }),
      voiceJob(),
      s.asSession,
    );
    expect(outcome).toBe('voice_notice');
  });

  it('marks the message as read but does not send the generic "received" ack for a voice note', async () => {
    const s = setup();
    await s.processor.handle(user(), voiceJob(), s.asSession);
    expect(s.whatsapp.markAsRead).toHaveBeenCalledTimes(1);
    expect(s.session.text).not.toHaveBeenCalledWith(
      'common.received_processing',
      expect.anything(),
    );
    expect(s.session.text).not.toHaveBeenCalledWith('common.received_processing');
  });

  it('a short note (about 10 s or less) gets no "listening" message', async () => {
    const s = setup({ bytes: LISTENING_ACK_MIN_BYTES });
    await s.processor.handle(user(), voiceJob(), s.asSession);
    expect(s.session.text).not.toHaveBeenCalledWith('voice.listening');
  });

  it('a longer note gets the "listening" message BEFORE the AI call', async () => {
    const s = setup({ bytes: LISTENING_ACK_MIN_BYTES + 1 });
    await s.processor.handle(user(), voiceJob(), s.asSession);
    expect(s.calls.indexOf('session.text')).toBeLessThan(s.calls.indexOf('ai.process'));
    expect(s.session.text).toHaveBeenCalledWith('voice.listening');
  });

  it('a detected command is returned to the router and NO reply is sent', async () => {
    const s = setup();
    s.ai.process.mockResolvedValue(response({ detected_command: 'meds' }));
    const outcome = await s.processor.handle(user(), voiceJob(), s.asSession);
    expect(outcome).toEqual({ outcome: 'voice_command', command: 'meds' });
    expect(s.session.rawText).not.toHaveBeenCalled();
  });

  it('an emergency reply is plain text at emergency priority and never spoken', async () => {
    const s = setup({ tts: true });
    s.ai.process.mockResolvedValue(
      response({
        emergency: true,
        emergency_category: 'cardiac',
        spoken_text: 'should never be used',
      }),
    );
    const outcome = await s.processor.handle(user({ voiceReplies: true }), voiceJob(), s.asSession);
    expect(outcome).toBe('ai_emergency');
    expect(s.session.rawEmergencyText).toHaveBeenCalledTimes(1);
    expect(s.ai.synthesize).not.toHaveBeenCalled();
  });

  it('a too-large voice note gets the size message and no AI call', async () => {
    const s = setup();
    s.media.storeInboundMedia.mockResolvedValue({ status: 'rejected', reason: 'too_large' });
    const outcome = await s.processor.handle(user(), voiceJob(), s.asSession);
    expect(outcome).toBe('media_rejected');
    expect(s.ai.process).not.toHaveBeenCalled();
  });
});

describe('AiProcessor: spoken replies (M13)', () => {
  const spokenResponse = (): ProcessResponse => response({ spoken_text: 'chhota jawab' });

  it('is OFF by default: no want_spoken, no synthesis', async () => {
    const s = setup({ tts: true });
    s.ai.process.mockResolvedValue(spokenResponse());
    await s.processor.handle(user({ voiceReplies: false }), voiceJob(), s.asSession);
    const request = s.ai.process.mock.calls[0]?.[0] as { options?: { want_spoken?: boolean } };
    expect(request.options?.want_spoken).toBe(false);
    expect(s.ai.synthesize).not.toHaveBeenCalled();
  });

  it('is OFF when the operator switched TTS off, even for a user with VOICE ON', async () => {
    const s = setup({ tts: false });
    s.ai.process.mockResolvedValue(spokenResponse());
    await s.processor.handle(user({ voiceReplies: true }), voiceJob(), s.asSession);
    expect(s.ai.synthesize).not.toHaveBeenCalled();
  });

  it('VOICE ON + TTS: the TEXT reply is sent first, then the audio is uploaded and queued', async () => {
    const s = setup({ tts: true });
    s.ai.process.mockResolvedValue(spokenResponse());
    await s.processor.handle(user({ voiceReplies: true }), voiceJob(), s.asSession);
    const request = s.ai.process.mock.calls[0]?.[0] as { options?: { want_spoken?: boolean } };
    expect(request.options?.want_spoken).toBe(true);
    expect(s.session.rawText).toHaveBeenCalledWith('जवाब');
    expect(s.calls.indexOf('session.rawText')).toBeLessThan(s.calls.indexOf('session.rawAudio'));
    expect(s.whatsapp.uploadMedia).toHaveBeenCalledWith(
      expect.any(Buffer),
      'audio/ogg',
      expect.anything(),
    );
    expect(s.session.rawAudio).toHaveBeenCalledWith('MEDIA42');
    const synth = s.ai.synthesize.mock.calls[0]?.[0] as { text: string; language: string };
    expect(synth).toMatchObject({ text: 'chhota jawab', language: 'hi' });
  });

  it('no spoken_text from the AI service means nothing is synthesised', async () => {
    const s = setup({ tts: true });
    await s.processor.handle(user({ voiceReplies: true }), voiceJob(), s.asSession);
    expect(s.ai.synthesize).not.toHaveBeenCalled();
  });

  it('a failing speech service never costs the user the text reply', async () => {
    const s = setup({ tts: true });
    s.ai.process.mockResolvedValue(spokenResponse());
    s.ai.synthesize.mockRejectedValue(new Error('speech down'));
    const outcome = await s.processor.handle(user({ voiceReplies: true }), voiceJob(), s.asSession);
    expect(outcome).toBe('ai_reply');
    expect(s.session.rawText).toHaveBeenCalledTimes(1);
    expect(s.session.rawAudio).not.toHaveBeenCalled();
  });

  it('a failing upload is also swallowed', async () => {
    const s = setup({ tts: true });
    s.ai.process.mockResolvedValue(spokenResponse());
    s.whatsapp.uploadMedia.mockRejectedValue(new Error('upload failed'));
    await expect(
      s.processor.handle(user({ voiceReplies: true }), voiceJob(), s.asSession),
    ).resolves.toBe('ai_reply');
  });
});
