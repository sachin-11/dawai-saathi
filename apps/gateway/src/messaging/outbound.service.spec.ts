import { randomBytes } from 'node:crypto';

import { UnrecoverableError } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import { CryptoService } from '../common/crypto/crypto.service';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { Env } from '../config/env.schema';
import type { MessagesService } from './messages.service';
import { outboundJobId } from './outbound.queue';
import type { OutboundQueue } from './outbound.queue';
import { OutboundService, type OutboundJobLike } from './outbound.service';
import type { OutboundJobData } from './outbound.types';
import { TemplateRegistry } from './template.registry';
import { MAX_TEXT_LENGTH } from './text-splitter';
import { WhatsAppApiError } from './whatsapp.errors';
import type { WhatsAppClient } from './whatsapp.client';
import { WINDOW_MS, WindowClosedError } from './window';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PHONE = '919876501234';
const crypto = new CryptoService({
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PHONE_HASH_PEPPER: 'unit-test-pepper',
} as Env);

interface Setup {
  service: OutboundService;
  queue: { add: jest.Mock };
  client: { sendText: jest.Mock; sendButtons: jest.Mock; sendTemplate: jest.Mock };
  messages: { saveOutbound: jest.Mock };
  prisma: { user: { findUniqueOrThrow: jest.Mock; findUnique: jest.Mock } };
  calls: string[];
}

function setup(user: { lastInboundAt: Date | null } | null = { lastInboundAt: new Date() }): Setup {
  const calls: string[] = [];
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  let counter = 0;
  // Separate mocks per method (so "sendText was NOT called" is meaningful) sharing one id counter.
  const makeSend = (): jest.Mock =>
    jest.fn().mockImplementation(() => {
      calls.push('send');
      counter += 1;
      return Promise.resolve({ waMessageId: `wamid.NEW${counter}` });
    });
  const client = { sendText: makeSend(), sendButtons: makeSend(), sendTemplate: makeSend() };
  const messages = {
    saveOutbound: jest.fn().mockImplementation(() => {
      calls.push('save');
      return Promise.resolve();
    }),
  };
  const prisma = {
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(user ?? { lastInboundAt: null }),
      findUnique: jest
        .fn()
        .mockResolvedValue(
          user ? { waPhoneEnc: crypto.encrypt(PHONE), lastInboundAt: user.lastInboundAt } : null,
        ),
    },
  };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new OutboundService(
    prisma as unknown as PrismaService,
    crypto,
    queue as unknown as OutboundQueue,
    client as unknown as WhatsAppClient,
    new TemplateRegistry(),
    messages as unknown as MessagesService,
    logger as unknown as PinoLogger,
  );
  return { service, queue, client, messages, prisma, calls };
}

function jobFor(
  payload: object,
  extra: Partial<OutboundJobData> = {},
): { job: OutboundJobLike; updateData: jest.Mock } {
  const updateData = jest.fn().mockImplementation((data: OutboundJobData) => {
    job.data = data;
    return Promise.resolve();
  });
  const job: OutboundJobLike = {
    data: {
      userId: USER_ID,
      payload: crypto.encrypt(JSON.stringify(payload)),
      sourceMessageId: 'msg-1',
      replyIndex: 0,
      requestId: 'req-1',
      ...extra,
    },
    updateData,
  };
  return { job, updateData };
}

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000);
const consentTemplate = {
  kind: 'template' as const,
  template: 'consent_reminder' as const,
  language: 'hi' as const,
  buttonPayloads: ['consent_yes', 'consent_no'],
};

describe('OutboundService.enqueue', () => {
  it('puts an encrypted payload on the queue: no readable text, no phone number', async () => {
    const s = setup();
    await s.service.enqueue(USER_ID, {
      content: { kind: 'text', body: 'Aapki dawai Dolo 650 subah leni hai' },
      sourceMessageId: 'msg-1',
      replyIndex: 0,
      requestId: 'req-1',
    });
    expect(s.queue.add).toHaveBeenCalledTimes(1);
    const data = s.queue.add.mock.calls[0]?.[0] as OutboundJobData;
    expect(data).toMatchObject({
      userId: USER_ID,
      sourceMessageId: 'msg-1',
      replyIndex: 0,
      requestId: 'req-1',
    });
    expect(data.payload).toMatch(/^v1:/);
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('Dolo');
    expect(serialised).not.toContain(PHONE);
    // ...but the worker can read it back
    expect(JSON.parse(crypto.decrypt(data.payload))).toEqual({
      content: { kind: 'text', body: 'Aapki dawai Dolo 650 subah leni hai' },
    });
  });

  it('derives the job id from (sourceMessageId, replyIndex): the same reply is the same job', () => {
    expect(outboundJobId('msg-1', 0)).toBe(outboundJobId('msg-1', 0));
    expect(outboundJobId('msg-1', 0)).not.toBe(outboundJobId('msg-1', 1));
    expect(outboundJobId('msg-1', 0)).not.toBe(outboundJobId('msg-2', 0));
    expect(outboundJobId('wamid:abc', 2)).not.toContain(':');
  });

  describe('24-hour window', () => {
    it('allows free-form text inside the window', async () => {
      const s = setup({ lastInboundAt: hoursAgo(23) });
      await expect(
        s.service.enqueue(USER_ID, {
          content: { kind: 'text', body: 'hi' },
          sourceMessageId: 'm',
          replyIndex: 0,
        }),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['25 hours ago', { lastInboundAt: hoursAgo(25) }],
      ['exactly 24 hours ago', { lastInboundAt: new Date(Date.now() - WINDOW_MS - 5) }],
      ['never', { lastInboundAt: null }],
    ])(
      'rejects text and buttons when the user last wrote %s (no fallback)',
      async (_name, user) => {
        const s = setup(user);
        await expect(
          s.service.enqueue(USER_ID, {
            content: { kind: 'text', body: 'hi' },
            sourceMessageId: 'm',
            replyIndex: 0,
          }),
        ).rejects.toBeInstanceOf(WindowClosedError);
        await expect(
          s.service.enqueue(USER_ID, {
            content: { kind: 'buttons', body: 'pick', buttons: [{ id: 'a', title: 'A' }] },
            sourceMessageId: 'm',
            replyIndex: 1,
          }),
        ).rejects.toBeInstanceOf(WindowClosedError);
        expect(s.queue.add).not.toHaveBeenCalled();
      },
    );

    it('accepts a closed window when a template fallback is supplied', async () => {
      const s = setup({ lastInboundAt: hoursAgo(30) });
      await s.service.enqueue(USER_ID, {
        content: { kind: 'text', body: 'hi' },
        templateFallback: consentTemplate,
        sourceMessageId: 'm',
        replyIndex: 0,
      });
      expect(s.queue.add).toHaveBeenCalledTimes(1);
    });

    it('always accepts a template message, even with a closed window', async () => {
      const s = setup({ lastInboundAt: null });
      await s.service.enqueue(USER_ID, {
        content: consentTemplate,
        sourceMessageId: 'm',
        replyIndex: 0,
      });
      expect(s.queue.add).toHaveBeenCalledTimes(1);
    });
  });
});

describe('OutboundService.deliver', () => {
  it('decrypts the phone number only now and sends text to it', async () => {
    const s = setup();
    const { job } = jobFor({ content: { kind: 'text', body: 'Namaste' } });
    await s.service.deliver(job);
    expect(s.client.sendText).toHaveBeenCalledWith(PHONE, 'Namaste', { requestId: 'req-1' });
  });

  it("records the outbound message with Meta's id, redacted body, and never the phone number", async () => {
    const s = setup();
    const { job } = jobFor({ content: { kind: 'text', body: 'Call 9876543210 for refill' } });
    await s.service.deliver(job);
    expect(s.messages.saveOutbound).toHaveBeenCalledWith({
      userId: USER_ID,
      waMessageId: 'wamid.NEW1',
      type: 'text',
      bodyRedacted: 'Call [REDACTED_PHONE] for refill',
    });
    expect(JSON.stringify(s.messages.saveOutbound.mock.calls)).not.toContain(PHONE);
  });

  it('writes the sent wamid into the job data BEFORE the database insert', async () => {
    const s = setup();
    const { job, updateData } = jobFor({ content: { kind: 'text', body: 'hi' } });
    await s.service.deliver(job);
    expect(s.calls).toEqual(['send', 'save']);
    expect(updateData).toHaveBeenCalledWith(expect.objectContaining({ sentWaIds: ['wamid.NEW1'] }));
  });

  it('splits text over 4096 characters into several messages, in order, one row each', async () => {
    const s = setup();
    const paragraph = 'p'.repeat(3000);
    const { job } = jobFor({
      content: { kind: 'text', body: `${paragraph}\n\n${paragraph}\n\n${paragraph}` },
    });
    await s.service.deliver(job);
    expect(s.client.sendText).toHaveBeenCalledTimes(3);
    for (const call of s.client.sendText.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    }
    expect(s.messages.saveOutbound).toHaveBeenCalledTimes(3);
    expect(job.data.sentWaIds).toEqual(['wamid.NEW1', 'wamid.NEW2', 'wamid.NEW3']);
  });

  describe('idempotent retries (the user must not get the same reply twice)', () => {
    it('does not send again when the wamid is already in the job data (retry after a failed insert)', async () => {
      const s = setup();
      const { job } = jobFor(
        { content: { kind: 'text', body: 'hi' } },
        { sentWaIds: ['wamid.EARLIER'] },
      );
      await s.service.deliver(job);
      expect(s.client.sendText).not.toHaveBeenCalled();
      expect(s.messages.saveOutbound).toHaveBeenCalledWith(
        expect.objectContaining({ waMessageId: 'wamid.EARLIER' }),
      );
    });

    it('resumes a multi-part reply: only the missing parts are sent', async () => {
      const s = setup();
      const paragraph = 'p'.repeat(3000);
      const { job } = jobFor(
        { content: { kind: 'text', body: `${paragraph}\n\n${paragraph}\n\n${paragraph}` } },
        { sentWaIds: ['wamid.PART1'] },
      );
      await s.service.deliver(job);
      expect(s.client.sendText).toHaveBeenCalledTimes(2);
      expect(job.data.sentWaIds).toEqual(['wamid.PART1', 'wamid.NEW1', 'wamid.NEW2']);
    });

    it('keeps progress when the database insert fails, so the retry does not resend', async () => {
      const s = setup();
      s.messages.saveOutbound.mockRejectedValueOnce(new Error('db down'));
      const { job } = jobFor({ content: { kind: 'text', body: 'hi' } });

      await expect(s.service.deliver(job)).rejects.toThrow('db down');
      expect(job.data.sentWaIds).toEqual(['wamid.NEW1']);

      await s.service.deliver(job); // the retry
      expect(s.client.sendText).toHaveBeenCalledTimes(1); // still exactly one send
      expect(s.messages.saveOutbound).toHaveBeenCalledTimes(2);
    });

    it('saves nothing and records no progress when the send itself fails', async () => {
      const s = setup();
      s.client.sendText.mockRejectedValueOnce(
        new WhatsAppApiError({ httpStatus: 500, kind: 'server', retryable: true, message: 'x' }),
      );
      const { job, updateData } = jobFor({ content: { kind: 'text', body: 'hi' } });
      await expect(s.service.deliver(job)).rejects.toBeInstanceOf(WhatsAppApiError);
      expect(updateData).not.toHaveBeenCalled();
      expect(s.messages.saveOutbound).not.toHaveBeenCalled();
    });
  });

  describe('24-hour window at send time', () => {
    it('sends the template fallback when the window closed while the job waited', async () => {
      const s = setup({ lastInboundAt: hoursAgo(30) });
      const { job } = jobFor({
        content: { kind: 'text', body: 'free-form reply' },
        templateFallback: consentTemplate,
      });
      await s.service.deliver(job);
      expect(s.client.sendText).not.toHaveBeenCalled();
      expect(s.client.sendTemplate).toHaveBeenCalledWith(
        PHONE,
        'consent_reminder',
        'hi',
        expect.any(Array),
        { requestId: 'req-1' },
      );
    });

    it('fails permanently (no retry) when the window is closed and there is no fallback', async () => {
      const s = setup({ lastInboundAt: hoursAgo(30) });
      const { job } = jobFor({ content: { kind: 'text', body: 'free-form reply' } });
      await expect(s.service.deliver(job)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(s.client.sendText).not.toHaveBeenCalled();
    });

    it('still sends a template message with a closed window', async () => {
      const s = setup({ lastInboundAt: null });
      const { job } = jobFor({ content: consentTemplate });
      await s.service.deliver(job);
      expect(s.client.sendTemplate).toHaveBeenCalledTimes(1);
    });
  });

  it('sends buttons and stores them as type "button"', async () => {
    const s = setup();
    const buttons = [
      { id: 'yes', title: 'Yes' },
      { id: 'no', title: 'No' },
    ];
    const { job } = jobFor({ content: { kind: 'buttons', body: 'Agree?', buttons } });
    await s.service.deliver(job);
    expect(s.client.sendButtons).toHaveBeenCalledWith(PHONE, 'Agree?', buttons, {
      requestId: 'req-1',
    });
    expect(s.messages.saveOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'button', bodyRedacted: 'Agree?' }),
    );
  });

  it('builds templates through the registry and stores only a marker, not the parameters', async () => {
    const s = setup();
    const { job } = jobFor({
      content: {
        kind: 'template',
        template: 'dose_reminder',
        language: 'en',
        params: { medicines: 'Dolo 650', time: '08:00' },
        buttonPayloads: ['taken:r1', 'snooze:r1', 'skip:r1'],
      },
    });
    await s.service.deliver(job);
    expect(s.client.sendTemplate).toHaveBeenCalledWith(
      PHONE,
      'dose_reminder',
      'en',
      expect.arrayContaining([expect.objectContaining({ type: 'body' })]),
      { requestId: 'req-1' },
    );
    expect(s.messages.saveOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'template', bodyRedacted: '[template:dose_reminder]' }),
    );
  });

  it('fails permanently when the recipient no longer exists (DELETE command ran)', async () => {
    const s = setup(null);
    const { job } = jobFor({ content: { kind: 'text', body: 'hi' } });
    await expect(s.service.deliver(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(s.client.sendText).not.toHaveBeenCalled();
  });
});
