import type { ReminderAckService } from '../reminders/reminder-ack.service';
import type { PinoLogger } from 'nestjs-pino';

import type { EchoBotService } from '../dev/echo-bot.service';
import type { InboundJobData } from '../queues/queue.constants';
import type { OnboardingStep, UserState, UsersService } from '../users/users.service';
import type { AiProcessor } from './ai-processor.service';
import type { CommandHandlersService } from './command-handlers.service';
import type { DeletionFlowService } from './deletion-flow.service';
import { DELETION_MARKER_TTL_MS, InboundRouter, type RouteOutcome } from './inbound-router';
import type { InteractionFlowService } from './interaction-flow.service';
import type { LabActionsService } from './lab-actions.service';
import type { OnboardingService } from './onboarding.service';
import type { CaregiverFlowService } from './caregiver-flow.service';
import type { PendingInputService } from './pending-input.service';
import type { ReminderFlowService } from './reminder-flow.service';
import type { RxActionsService } from './rx-actions.service';
import type { RepliesService } from './replies.service';

const NOW = new Date('2026-11-07T12:00:00Z');

const user = (overrides: Partial<UserState> = {}): UserState => ({
  id: 'user-1',
  language: 'hi',
  onboardingStep: 'done',
  consentAt: new Date('2026-11-01T00:00:00Z'),
  remindersEnabled: true,
  consentVersion: 'v2',
  voiceReplies: false,
  deletedAt: null,
  ...overrides,
});

const job = (overrides: Partial<InboundJobData> = {}): InboundJobData => ({
  messageId: 'msg-1',
  userId: 'user-1',
  waMessageId: 'wamid.1',
  type: 'text',
  receivedAt: NOW.toISOString(),
  requestId: 'req-1',
  ...overrides,
});

function setup(
  state: UserState | null,
  options: { echoEnabled?: boolean } = {},
): {
  router: InboundRouter;
  session: Record<'text' | 'textParts' | 'buttons' | 'emergency' | 'useLanguage', jest.Mock>;
  onboarding: { handle: jest.Mock };
  commands: Record<
    | 'help'
    | 'askLanguage'
    | 'setLanguage'
    | 'setReminders'
    | 'meds'
    | 'setVoiceReplies'
    | 'answerVoiceNotice',
    jest.Mock
  >;
  deletion: Record<'request' | 'confirm' | 'cancel', jest.Mock>;
  echoBot: { enabled: boolean; handle: jest.Mock };
  rxActions: { handle: jest.Mock };
  interactionFlow: { check: jest.Mock; details: jest.Mock };
  labActions: { list: jest.Mock; handle: jest.Mock; handleRep: jest.Mock };
  ai: { handle: jest.Mock };
  reminderFlow: { list: jest.Mock; handleButton: jest.Mock };
  caregiverFlow: { startAdd: jest.Mock; remove: jest.Mock };
  pendingInput: { handle: jest.Mock };
  acks: { handleText: jest.Mock };
} {
  const session = {
    text: jest.fn().mockResolvedValue(undefined),
    textParts: jest.fn().mockResolvedValue(undefined),
    buttons: jest.fn().mockResolvedValue(undefined),
    emergency: jest.fn().mockResolvedValue(undefined),
    useLanguage: jest.fn(),
  };
  const onboarding = { handle: jest.fn().mockResolvedValue(undefined) };
  const commands = {
    help: jest.fn().mockResolvedValue(undefined),
    askLanguage: jest.fn().mockResolvedValue(undefined),
    setLanguage: jest.fn().mockResolvedValue(undefined),
    setReminders: jest.fn().mockResolvedValue(undefined),
    meds: jest.fn().mockResolvedValue(undefined),
    setVoiceReplies: jest.fn().mockResolvedValue(undefined),
    answerVoiceNotice: jest.fn().mockResolvedValue(undefined),
  };
  const deletion = {
    request: jest.fn().mockResolvedValue(undefined),
    confirm: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  const echoBot = {
    enabled: options.echoEnabled === true,
    handle: jest.fn().mockResolvedValue(undefined),
  };
  const ai = { handle: jest.fn().mockResolvedValue('ai_reply') };
  const rxActions = { handle: jest.fn().mockResolvedValue('rx_wrong') };
  const interactionFlow = {
    check: jest.fn().mockResolvedValue('check_done'),
    details: jest.fn().mockResolvedValue('ix_details'),
  };
  const labActions = {
    list: jest.fn().mockResolvedValue('reports_list'),
    handle: jest.fn().mockResolvedValue('lab_all'),
    handleRep: jest.fn().mockResolvedValue('report_shown'),
  };
  const reminderFlow = {
    list: jest.fn().mockResolvedValue('rem_list'),
    handleButton: jest.fn().mockResolvedValue('rem_ack'),
  };
  const caregiverFlow = {
    startAdd: jest.fn().mockResolvedValue('cg_ask_label'),
    remove: jest.fn().mockResolvedValue('cg_removed'),
  };
  const pendingInput = { handle: jest.fn().mockResolvedValue(null) };
  const acks = { handleText: jest.fn().mockResolvedValue(null) };
  const logger = { setContext: jest.fn(), info: jest.fn() };
  const router = new InboundRouter(
    { getState: jest.fn().mockResolvedValue(state) } as unknown as UsersService,
    { session: jest.fn().mockReturnValue(session) } as unknown as RepliesService,
    onboarding as unknown as OnboardingService,
    commands as unknown as CommandHandlersService,
    deletion as unknown as DeletionFlowService,
    rxActions as unknown as RxActionsService,
    interactionFlow as unknown as InteractionFlowService,
    labActions as unknown as LabActionsService,
    reminderFlow as unknown as ReminderFlowService,
    caregiverFlow as unknown as CaregiverFlowService,
    pendingInput as unknown as PendingInputService,
    acks as unknown as ReminderAckService,
    echoBot as unknown as EchoBotService,
    ai as unknown as AiProcessor,
    logger as unknown as PinoLogger,
  );
  return {
    labActions,
    router,
    session,
    onboarding,
    commands,
    deletion,
    echoBot,
    ai,
    rxActions,
    interactionFlow,
    reminderFlow,
    caregiverFlow,
    pendingInput,
    acks,
  };
}

const STEPS: OnboardingStep[] = ['language', 'consent', 'done'];

describe('InboundRouter', () => {
  describe('unknown / erased users', () => {
    it('ignores a message for a user that no longer exists', async () => {
      const s = setup(null);
      await expect(s.router.route(job(), NOW)).resolves.toBe<RouteOutcome>('ignored_unknown_user');
      expect(s.session.text).not.toHaveBeenCalled();
      expect(s.onboarding.handle).not.toHaveBeenCalled();
    });

    it('ignores a user whose erasure is in flight', async () => {
      const s = setup(user({ deletedAt: new Date(NOW.getTime() - 60_000) }));
      await expect(s.router.route(job({ signals: { emergency: 'general' } }), NOW)).resolves.toBe(
        'ignored_deletion_pending',
      );
      expect(s.session.emergency).not.toHaveBeenCalled();
    });

    it('stops ignoring a user whose deletion marker is stale (a stuck job must not silence them forever)', async () => {
      const s = setup(user({ deletedAt: new Date(NOW.getTime() - DELETION_MARKER_TTL_MS - 1) }));
      await expect(s.router.route(job(), NOW)).resolves.toBe('ai_reply');
    });
  });

  describe('1. emergency beats everything', () => {
    it.each(STEPS)('answers an emergency for a user in step "%s"', async (step) => {
      const s = setup(user({ onboardingStep: step }));
      await expect(s.router.route(job({ signals: { emergency: 'general' } }), NOW)).resolves.toBe(
        'emergency',
      );
      // bilingual only while no language has been chosen yet
      expect(s.session.emergency).toHaveBeenCalledWith('general', step === 'language');
    });

    it('never calls the AI service when the gateway pre-check fires (works with the AI service down)', async () => {
      const s = setup(user());
      s.ai.handle.mockRejectedValue(new Error('AI service is down'));
      await expect(s.router.route(job({ signals: { emergency: 'general' } }), NOW)).resolves.toBe(
        'emergency',
      );
      expect(s.ai.handle).not.toHaveBeenCalled();
      expect(s.session.emergency).toHaveBeenCalledTimes(1);
    });

    it('passes the self-harm kind through', async () => {
      const s = setup(user());
      await s.router.route(job({ signals: { emergency: 'self_harm' } }), NOW);
      expect(s.session.emergency).toHaveBeenCalledWith('self_harm', false);
    });

    it('beats a command and does nothing else (no onboarding, no deletion, no processing)', async () => {
      const s = setup(user({ onboardingStep: 'language' }));
      await s.router.route(job({ signals: { emergency: 'general', command: 'delete' } }), NOW);
      expect(s.deletion.request).not.toHaveBeenCalled();
      expect(s.onboarding.handle).not.toHaveBeenCalled();
      expect(s.commands.help).not.toHaveBeenCalled();
      expect(s.echoBot.handle).not.toHaveBeenCalled();
    });

    it('works for an image caption before consent without touching the media', async () => {
      const s = setup(user({ onboardingStep: 'consent' }));
      const outcome = await s.router.route(
        job({
          type: 'image',
          media: { id: 'm1', mimeType: 'image/jpeg' },
          signals: { emergency: 'general' },
        }),
        NOW,
      );
      expect(outcome).toBe('emergency');
    });
  });

  describe('2. global commands work in every onboarding step', () => {
    it.each(STEPS)('DELETE in step "%s"', async (step) => {
      const s = setup(user({ onboardingStep: step }));
      await expect(s.router.route(job({ signals: { command: 'delete' } }), NOW)).resolves.toBe(
        'delete_request',
      );
      expect(s.deletion.request).toHaveBeenCalledTimes(1);
      expect(s.onboarding.handle).not.toHaveBeenCalled();
    });

    it.each(STEPS)('delete:confirm button in step "%s"', async (step) => {
      const s = setup(user({ onboardingStep: step }));
      await expect(
        s.router.route(job({ type: 'button', button: { id: 'delete:confirm', title: 'x' } }), NOW),
      ).resolves.toBe('delete_confirm');
      expect(s.deletion.confirm).toHaveBeenCalledTimes(1);
    });

    it.each(STEPS)('delete:cancel button in step "%s"', async (step) => {
      const s = setup(user({ onboardingStep: step }));
      await expect(
        s.router.route(job({ type: 'button', button: { id: 'delete:cancel', title: 'x' } }), NOW),
      ).resolves.toBe('delete_cancel');
      expect(s.deletion.cancel).toHaveBeenCalledTimes(1);
    });

    it.each(STEPS)('HELP in step "%s"', async (step) => {
      const s = setup(user({ onboardingStep: step }));
      await expect(s.router.route(job({ signals: { command: 'help' } }), NOW)).resolves.toBe(
        'help',
      );
      expect(s.commands.help).toHaveBeenCalledTimes(1);
      expect(s.onboarding.handle).not.toHaveBeenCalled();
    });

    it('matches the delete button by its id, never by its visible title', async () => {
      const s = setup(user({ onboardingStep: 'done' }));
      await s.router.route(
        job({ type: 'button', button: { id: 'something:else', title: 'delete:confirm' } }),
        NOW,
      );
      expect(s.deletion.confirm).not.toHaveBeenCalled();
    });
  });

  describe('3. onboarding gate (consent first)', () => {
    it.each(['language', 'consent'] as const)(
      'sends text of a user in step "%s" to onboarding only',
      async (step) => {
        const s = setup(user({ onboardingStep: step }));
        await expect(s.router.route(job({ type: 'text' }), NOW)).resolves.toBe('onboarding');
        expect(s.onboarding.handle).toHaveBeenCalledTimes(1);
        expect(s.echoBot.handle).not.toHaveBeenCalled();
        expect(s.session.textParts).not.toHaveBeenCalled();
      },
    );

    it.each(['image', 'document', 'audio'] as const)(
      'a %s sent before consent goes to onboarding: never processed, never echoed',
      async (type) => {
        const s = setup(user({ onboardingStep: 'consent' }), { echoEnabled: true });
        await expect(
          s.router.route(job({ type, media: { id: 'm1', mimeType: 'image/jpeg' } }), NOW),
        ).resolves.toBe('onboarding');
        expect(s.echoBot.handle).not.toHaveBeenCalled();
        expect(s.session.textParts).not.toHaveBeenCalled();
      },
    );

    it.each(['language', 'meds', 'stop_reminders', 'start_reminders'] as const)(
      'the active-user command "%s" is not available before onboarding is done',
      async (command) => {
        const s = setup(user({ onboardingStep: 'consent' }));
        await expect(s.router.route(job({ signals: { command } }), NOW)).resolves.toBe(
          'onboarding',
        );
        expect(s.commands.meds).not.toHaveBeenCalled();
        expect(s.commands.setReminders).not.toHaveBeenCalled();
        expect(s.commands.askLanguage).not.toHaveBeenCalled();
      },
    );
  });

  describe('4. commands for onboarded users', () => {
    it('LANGUAGE shows the language buttons', async () => {
      const s = setup(user());
      await expect(s.router.route(job({ signals: { command: 'language' } }), NOW)).resolves.toBe(
        'language_prompt',
      );
      expect(s.commands.askLanguage).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['lang:hi', 'hi'],
      ['lang:en', 'en'],
    ] as const)('button %s switches the language', async (id, language) => {
      const s = setup(user({ language: language === 'hi' ? 'en' : 'hi' }));
      await expect(
        s.router.route(job({ type: 'button', button: { id, title: 'x' } }), NOW),
      ).resolves.toBe('language_changed');
      expect(s.commands.setLanguage).toHaveBeenCalledWith(expect.anything(), language, s.session);
    });

    it('STOP REMINDERS and START REMINDERS set the flag', async () => {
      const s = setup(user());
      await expect(
        s.router.route(job({ signals: { command: 'stop_reminders' } }), NOW),
      ).resolves.toBe('reminders_stopped');
      expect(s.commands.setReminders).toHaveBeenLastCalledWith(expect.anything(), false, s.session);
      await expect(
        s.router.route(job({ signals: { command: 'start_reminders' } }), NOW),
      ).resolves.toBe('reminders_started');
      expect(s.commands.setReminders).toHaveBeenLastCalledWith(expect.anything(), true, s.session);
    });

    it('MEDS lists the medicines', async () => {
      const s = setup(user());
      await expect(s.router.route(job({ signals: { command: 'meds' } }), NOW)).resolves.toBe(
        'meds',
      );
      expect(s.commands.meds).toHaveBeenCalledTimes(1);
    });

    it('replays the welcome when a retried consent:yes finds onboarding already finished', async () => {
      const s = setup(user());
      await expect(
        s.router.route(job({ type: 'button', button: { id: 'consent:yes', title: 'x' } }), NOW),
      ).resolves.toBe('welcome_replay');
      expect(s.session.text).toHaveBeenCalledWith('consent.v2.accepted_welcome');
    });
  });

  describe('5. everything else (consented users only) goes to the AI processor', () => {
    it.each(['text', 'image', 'document', 'audio', 'unsupported'] as const)(
      'a %s is handed to the AI processor with the user, the job and the reply session',
      async (type) => {
        const s = setup(user());
        const j = job({ type });
        await expect(s.router.route(j, NOW)).resolves.toBe('ai_reply');
        expect(s.ai.handle).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'user-1' }),
          j,
          s.session,
        );
        expect(s.echoBot.handle).not.toHaveBeenCalled();
      },
    );

    it('returns whatever outcome the AI processor reports', async () => {
      const s = setup(user());
      s.ai.handle.mockResolvedValue('media_rejected');
      await expect(s.router.route(job({ type: 'image' }), NOW)).resolves.toBe('media_rejected');
    });

    it('lets an AI failure propagate so the inbound job is retried', async () => {
      const s = setup(user());
      s.ai.handle.mockRejectedValue(new Error('ai down'));
      await expect(s.router.route(job(), NOW)).rejects.toThrow('ai down');
    });

    it('runs the dev echo bot INSTEAD of the AI only when it is enabled', async () => {
      const on = setup(user(), { echoEnabled: true });
      await expect(on.router.route(job(), NOW)).resolves.toBe('echo_bot');
      expect(on.echoBot.handle).toHaveBeenCalledTimes(1);
      expect(on.ai.handle).not.toHaveBeenCalled();

      const off = setup(user(), { echoEnabled: false });
      await expect(off.router.route(job(), NOW)).resolves.toBe('ai_reply');
      expect(off.echoBot.handle).not.toHaveBeenCalled();
    });

    it('never reaches the AI before onboarding is done, whatever was sent', async () => {
      for (const step of ['language', 'consent'] as const) {
        const s = setup(user({ onboardingStep: step }));
        await s.router.route(
          job({ type: 'image', media: { id: 'm', mimeType: 'image/jpeg' } }),
          NOW,
        );
        await s.router.route(job({ type: 'text' }), NOW);
        expect(s.ai.handle).not.toHaveBeenCalled();
      }
    });

    it('commands and emergencies are answered without calling the AI', async () => {
      const s = setup(user());
      await s.router.route(job({ signals: { command: 'meds' } }), NOW);
      await s.router.route(job({ signals: { command: 'help' } }), NOW);
      await s.router.route(job({ signals: { emergency: 'general' } }), NOW);
      expect(s.ai.handle).not.toHaveBeenCalled();
    });
  });

  describe('lab reports (M12)', () => {
    const DOC = '3f2b8c1e-5d0a-4b7e-9c61-0a1b2c3d4e5f';
    const buttonJob = (id: string): InboundJobData =>
      job({ type: 'button', button: { id, title: 'whatever the title says' } });

    it('REPORTS goes to the lab actions, never to the AI', async () => {
      const s = setup(user());
      await expect(s.router.route(job({ signals: { command: 'reports' } }), NOW)).resolves.toBe(
        'reports_list',
      );
      expect(s.labActions.list).toHaveBeenCalled();
      expect(s.ai.handle).not.toHaveBeenCalled();
    });

    it.each(['all', 'wrong'] as const)(
      'routes lab:%s:<id> by id, never by title',
      async (action) => {
        const s = setup(user());
        await expect(s.router.route(buttonJob(`lab:${action}:${DOC}`), NOW)).resolves.toBe(
          'lab_all',
        );
        expect(s.labActions.handle).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'user-1' }),
          { action, documentId: DOC },
          s.session,
        );
        expect(s.ai.handle).not.toHaveBeenCalled();
      },
    );

    it('routes rep:show:<id> and rep:page:<n> to the REPORTS list', async () => {
      const s = setup(user());
      await s.router.route(buttonJob(`rep:show:${DOC}`), NOW);
      await s.router.route(buttonJob('rep:page:1'), NOW);
      expect(s.labActions.handleRep).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        { kind: 'show', documentId: DOC },
        s.session,
      );
      expect(s.labActions.handleRep).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        { kind: 'page', page: 1 },
        s.session,
      );
    });

    it('REPORTS does not work before consent (onboarding comes first)', async () => {
      const s = setup(user({ onboardingStep: 'consent' }));
      await expect(s.router.route(job({ signals: { command: 'reports' } }), NOW)).resolves.toBe(
        'onboarding',
      );
      expect(s.labActions.list).not.toHaveBeenCalled();
    });
  });

  describe('prescription buttons (M7)', () => {
    const rxJob = (id: string): InboundJobData =>
      job({ type: 'button', button: { id, title: 'whatever the title says' } });
    const DOC = '3f2b8c1e-5d0a-4b7e-9c61-0a1b2c3d4e5f';

    it.each(['reminders', 'generic', 'wrong'] as const)(
      'routes rx:%s:<id> to the prescription actions, never to the AI',
      async (action) => {
        const s = setup(user());
        await expect(s.router.route(rxJob(`rx:${action}:${DOC}`), NOW)).resolves.toBe('rx_wrong');
        expect(s.rxActions.handle).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'user-1' }),
          { action, documentId: DOC },
          s.session,
        );
        expect(s.ai.handle).not.toHaveBeenCalled();
      },
    );

    it('matches on the button id, not the title', async () => {
      const s = setup(user());
      await s.router.route(
        job({ type: 'button', button: { id: 'something:else', title: 'Something is wrong' } }),
        NOW,
      );
      expect(s.rxActions.handle).not.toHaveBeenCalled();
    });

    it('is not reachable before onboarding is done', async () => {
      const s = setup(user({ onboardingStep: 'consent' }));
      await s.router.route(rxJob(`rx:wrong:${DOC}`), NOW);
      expect(s.rxActions.handle).not.toHaveBeenCalled();
    });
  });

  describe('interaction checks (M11)', () => {
    const DOC = '3f2b8c1e-5d0a-4b7e-9c61-0a1b2c3d4e5f';
    const ixJob = (id: string): InboundJobData =>
      job({ type: 'button', button: { id, title: 'whatever the title says' } });

    it('CHECK re-runs the interaction check on all medicines', async () => {
      const s = setup(user());
      await expect(s.router.route(job({ signals: { command: 'check' } }), NOW)).resolves.toBe(
        'interaction_check',
      );
      expect(s.interactionFlow.check).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        s.session,
      );
      expect(s.ai.handle).not.toHaveBeenCalled();
    });

    it('CHECK is not available before onboarding is done', async () => {
      const s = setup(user({ onboardingStep: 'consent' }));
      await s.router.route(job({ signals: { command: 'check' } }), NOW);
      expect(s.interactionFlow.check).not.toHaveBeenCalled();
    });

    it.each([DOC, 'all'])(
      'routes ix:details:%s to the details flow, never to the AI',
      async (target) => {
        const s = setup(user());
        await expect(s.router.route(ixJob(`ix:details:${target}`), NOW)).resolves.toBe(
          'interaction_details',
        );
        expect(s.interactionFlow.details).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'user-1' }),
          { target },
          s.session,
        );
        expect(s.ai.handle).not.toHaveBeenCalled();
      },
    );

    it('a malformed ix id is not a details button', async () => {
      const s = setup(user());
      await s.router.route(ixJob('ix:details:not-an-id'), NOW);
      expect(s.interactionFlow.details).not.toHaveBeenCalled();
    });
  });

  describe('reminders and caregivers (M10)', () => {
    const active = (): UserState => user();

    it('REMINDERS lists the reminders', async () => {
      const s = setup(active());
      await expect(s.router.route(job({ signals: { command: 'reminders' } }), NOW)).resolves.toBe(
        'reminders_list',
      );
      expect(s.reminderFlow.list).toHaveBeenCalled();
      expect(s.ai.handle).not.toHaveBeenCalled();
    });

    it('CAREGIVER <number> and CAREGIVER REMOVE go to the caregiver flow', async () => {
      const s = setup(active());
      await expect(
        s.router.route(job({ signals: { command: 'caregiver_add' } }), NOW),
      ).resolves.toBe('caregiver');
      await expect(
        s.router.route(job({ signals: { command: 'caregiver_remove' } }), NOW),
      ).resolves.toBe('caregiver');
      expect(s.caregiverFlow.startAdd).toHaveBeenCalledTimes(1);
      expect(s.caregiverFlow.remove).toHaveBeenCalledTimes(1);
    });

    it.each([
      'rem:taken:1794277800',
      'rem:snooze:1794277800',
      'rem:skip:1794277800',
      'rem:renew:yes',
      'rem:page:1',
    ])('routes the button %s to the reminder flow by id', async (id) => {
      const s = setup(active());
      await expect(
        s.router.route(job({ type: 'button', button: { id, title: 'x' } }), NOW),
      ).resolves.toBe('reminder_flow');
      expect(s.reminderFlow.handleButton).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        id,
        s.session,
      );
      expect(s.ai.handle).not.toHaveBeenCalled();
    });

    it('a text answer to a pending question is consumed before anything else', async () => {
      const s = setup(active());
      s.pendingInput.handle.mockResolvedValue('rem_times_set');
      await expect(s.router.route(job({ signals: { input: true } }), NOW)).resolves.toBe(
        'input_handled',
      );
      expect(s.ai.handle).not.toHaveBeenCalled();
    });

    it('if the question expired meanwhile, the text takes the normal path', async () => {
      const s = setup(active());
      s.pendingInput.handle.mockResolvedValue(null);
      await s.router.route(job({ signals: { input: true } }), NOW);
      expect(s.ai.handle).toHaveBeenCalled();
    });

    it('"le li" is an ack only while a reminder is open', async () => {
      const open = setup(active());
      open.acks.handleText.mockResolvedValue('taken');
      await expect(open.router.route(job({ signals: { ack: 'taken' } }), NOW)).resolves.toBe(
        'reminder_ack_text',
      );
      expect(open.ai.handle).not.toHaveBeenCalled();

      const none = setup(active());
      none.acks.handleText.mockResolvedValue(null);
      await none.router.route(job({ signals: { ack: 'taken' } }), NOW);
      expect(none.ai.handle).toHaveBeenCalled();
    });

    it('none of this is reachable before onboarding is done or during an erasure', async () => {
      const early = setup(user({ onboardingStep: 'consent' }));
      await early.router.route(job({ signals: { command: 'reminders' } }), NOW);
      await early.router.route(job({ signals: { ack: 'taken' } }), NOW);
      expect(early.reminderFlow.list).not.toHaveBeenCalled();
      expect(early.acks.handleText).not.toHaveBeenCalled();

      const erasing = setup(user({ deletedAt: NOW }));
      await expect(
        erasing.router.route(job({ signals: { command: 'caregiver_add' } }), NOW),
      ).resolves.toBe('ignored_deletion_pending');
    });
  });
});

describe('InboundRouter: voice (M13)', () => {
  const voiceJob = job({ type: 'audio' });

  it('runs a spoken MEDS like the typed command', async () => {
    const s = setup(user());
    s.ai.handle.mockResolvedValue({ outcome: 'voice_command', command: 'meds' });
    await expect(s.router.route(voiceJob, NOW)).resolves.toBe('voice_command');
    expect(s.commands.meds).toHaveBeenCalledTimes(1);
  });

  it('spoken DELETE only shows the confirmation (nothing is erased on a transcript)', async () => {
    const s = setup(user());
    s.ai.handle.mockResolvedValue({ outcome: 'voice_command', command: 'delete' });
    await s.router.route(voiceJob, NOW);
    expect(s.deletion.request).toHaveBeenCalledTimes(1);
    expect(s.deletion.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ['reminder_taken', 'taken'],
    ['reminder_snooze', 'snooze'],
    ['reminder_skip', 'skip'],
  ])('spoken %s is applied to the open reminder as "%s"', async (command, kind) => {
    const s = setup(user());
    s.ai.handle.mockResolvedValue({ outcome: 'voice_command', command });
    s.acks.handleText.mockResolvedValue('taken');
    await s.router.route(voiceJob, NOW);
    expect(s.acks.handleText).toHaveBeenCalledWith('user-1', kind, s.session);
    expect(s.session.text).not.toHaveBeenCalled();
  });

  it('"le li" with no open reminder says so instead of marking anything', async () => {
    const s = setup(user());
    s.ai.handle.mockResolvedValue({ outcome: 'voice_command', command: 'reminder_taken' });
    s.acks.handleText.mockResolvedValue(null);
    await s.router.route(voiceJob, NOW);
    expect(s.session.text).toHaveBeenCalledWith('voice.no_open_reminder');
  });

  it('spoken stop reminders / start reminders / voice on / voice off use the typed handlers', async () => {
    const s = setup(user());
    for (const command of ['stop_reminders', 'start_reminders', 'voice_on', 'voice_off']) {
      s.ai.handle.mockResolvedValueOnce({ outcome: 'voice_command', command });
      await s.router.route(voiceJob, NOW);
    }
    expect(s.commands.setReminders.mock.calls.map((c: unknown[]) => c[1] as boolean)).toEqual([
      false,
      true,
    ]);
    expect(s.commands.setVoiceReplies.mock.calls.map((c: unknown[]) => c[1] as boolean)).toEqual([
      true,
      false,
    ]);
  });

  it('a command the voice path does not support is explained, never guessed', async () => {
    const s = setup(user());
    s.ai.handle.mockResolvedValue({ outcome: 'voice_command', command: 'caregiver_add' });
    await s.router.route(voiceJob, NOW);
    expect(s.session.text).toHaveBeenCalledWith('voice.command_unavailable');
  });

  it('a normal AI outcome passes straight through', async () => {
    const s = setup(user());
    s.ai.handle.mockResolvedValue('ai_reply');
    await expect(s.router.route(voiceJob, NOW)).resolves.toBe('ai_reply');
  });

  it('VOICE ON / VOICE OFF typed commands and the notice buttons', async () => {
    const s = setup(user());
    await expect(s.router.route(job({ signals: { command: 'voice_on' } }), NOW)).resolves.toBe(
      'voice_replies_changed',
    );
    expect(s.commands.setVoiceReplies).toHaveBeenCalledWith(expect.anything(), true, s.session);
    await expect(
      s.router.route(job({ type: 'button', button: { id: 'voice:ok', title: 'x' } }), NOW),
    ).resolves.toBe('voice_notice_answered');
    expect(s.commands.answerVoiceNotice).toHaveBeenCalledWith(expect.anything(), true, s.session);
  });

  it('an emergency signal still comes first', async () => {
    const s = setup(user());
    await s.router.route(job({ type: 'audio', signals: { emergency: 'general' } }), NOW);
    expect(s.session.emergency).toHaveBeenCalled();
    expect(s.ai.handle).not.toHaveBeenCalled();
  });
});
