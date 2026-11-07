import type { PinoLogger } from 'nestjs-pino';

import type { Env } from '../config/env.schema';
import type { MessagesService } from '../messaging/messages.service';
import type { StatusUpdater } from '../messaging/status-updater.service';
import type { InboundQueue } from '../queues/inbound.queue';
import type { InboundJobData } from '../queues/queue.constants';
import type { OnboardingStep, UserState, UsersService } from '../users/users.service';
import { WebhookService } from './webhook.service';

const PHONE_NUMBER_ID = '100000000000001';
const SENDER = '919876501234';

function body(message: Record<string, unknown>): unknown {
  return {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [{ from: SENDER, id: 'wamid.IN1', timestamp: '1794000000', ...message }],
            },
          },
        ],
      },
    ],
  };
}
const text = (value: string): unknown => body({ type: 'text', text: { body: value } });

function setup(step: OnboardingStep): {
  service: WebhookService;
  saveInbound: jest.Mock;
  add: jest.Mock;
  touchLastInbound: jest.Mock;
  apply: jest.Mock;
} {
  const user: UserState = {
    id: 'user-1',
    language: 'hi',
    onboardingStep: step,
    consentAt: null,
    remindersEnabled: true,
    deletedAt: null,
  };
  const saveInbound = jest
    .fn()
    .mockResolvedValue({ id: 'msg-1', userId: 'user-1', duplicate: false });
  const add = jest.fn().mockResolvedValue(undefined);
  const touchLastInbound = jest.fn().mockResolvedValue(undefined);
  const apply = jest.fn().mockResolvedValue(undefined);
  const service = new WebhookService(
    { WA_PHONE_NUMBER_ID: PHONE_NUMBER_ID } as Env,
    {
      findOrCreateByPhone: jest.fn().mockResolvedValue(user),
      touchLastInbound,
    } as unknown as UsersService,
    { saveInbound } as unknown as MessagesService,
    { add } as unknown as InboundQueue,
    { apply } as unknown as StatusUpdater,
    { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as PinoLogger,
  );
  return { service, saveInbound, add, touchLastInbound, apply };
}

describe('WebhookService (M4 behaviour)', () => {
  describe('pre-consent data minimisation (CLAUDE.md §2.7)', () => {
    it.each<[OnboardingStep, boolean]>([
      ['language', false],
      ['consent', false],
      ['done', true],
    ])('a user in step "%s": storeBody=%s', async (step, storeBody) => {
      const s = setup(step);
      await s.service.handle(text('hello'), 'req-1');
      expect(s.saveInbound).toHaveBeenCalledWith('user-1', expect.anything(), { storeBody });
    });

    it('still records the metadata and enqueues the job for a user who has not consented', async () => {
      const s = setup('consent');
      await s.service.handle(
        body({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg' } }),
        'req-1',
      );
      expect(s.saveInbound).toHaveBeenCalledTimes(1);
      expect(s.touchLastInbound).toHaveBeenCalledTimes(1);
      expect(s.add).toHaveBeenCalledTimes(1);
      expect((s.add.mock.calls[0]?.[0] as InboundJobData).media).toMatchObject({ id: 'm1' });
    });
  });

  describe('signals for the router', () => {
    const jobOf = (s: ReturnType<typeof setup>): InboundJobData =>
      s.add.mock.calls[0]?.[0] as InboundJobData;

    it('puts an emergency into the job as a small enum', async () => {
      const s = setup('language');
      await s.service.handle(text('mujhe seene me dard ho raha hai'), 'req-1');
      expect(jobOf(s).signals).toEqual({ emergency: 'general' });
    });

    it('flags self-harm', async () => {
      const s = setup('language');
      await s.service.handle(text('I want to die'), 'req-1');
      expect(jobOf(s).signals).toEqual({ emergency: 'self_harm' });
    });

    it.each([
      ['HELP', 'help'],
      ['  delete my data  ', 'delete'],
      ['stop reminders', 'stop_reminders'],
      ['dawai', 'meds'],
    ])('turns %p into the command "%s"', async (message, command) => {
      const s = setup('done');
      await s.service.handle(text(message), 'req-1');
      expect(jobOf(s).signals).toEqual({ command });
    });

    it('adds no signals key for an ordinary message', async () => {
      const s = setup('done');
      await s.service.handle(text('Dolo 650 kab leni hai?'), 'req-1');
      expect(jobOf(s)).not.toHaveProperty('signals');
    });

    it('routes a button tap by its id only: its title never becomes a command', async () => {
      const s = setup('done');
      await s.service.handle(
        body({
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'lang:hi', title: 'delete' } },
        }),
        'req-1',
      );
      expect(jobOf(s)).not.toHaveProperty('signals');
      expect(jobOf(s).button).toEqual({ id: 'lang:hi', title: 'delete' });
    });

    it('checks an image caption for emergencies but never treats it as a command', async () => {
      const s = setup('consent');
      await s.service.handle(
        body({
          type: 'image',
          image: { id: 'm1', mime_type: 'image/jpeg', caption: 'he is unconscious' },
        }),
        'req-1',
      );
      expect(jobOf(s).signals).toEqual({ emergency: 'general' });
    });

    it('never puts the message text or the phone number into the queue job', async () => {
      const s = setup('consent');
      await s.service.handle(text('chest pain, call me on 9876543210'), 'req-1');
      const serialised = JSON.stringify(jobOf(s));
      expect(serialised).not.toContain('chest pain');
      expect(serialised).not.toContain('9876543210');
      expect(serialised).not.toContain(SENDER);
    });
  });

  it('applies status updates without creating user messages', async () => {
    const s = setup('done');
    const statusBody = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1794000000' }],
              },
            },
          ],
        },
      ],
    };
    await s.service.handle(statusBody, 'req-1');
    expect(s.apply).toHaveBeenCalledTimes(1);
    expect(s.saveInbound).not.toHaveBeenCalled();
    expect(s.add).not.toHaveBeenCalled();
  });
});
