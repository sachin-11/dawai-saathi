import type { PinoLogger } from 'nestjs-pino';

import type { AiClient } from '../ai-client/ai-client';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { MedicationWarningsService } from '../medications/medication-warnings.service';
import type { UserState, UsersService } from '../users/users.service';
import { InteractionFlowService, parseIxButton } from './interaction-flow.service';
import type { ReplySession } from './replies.service';

const DOC = '44444444-4444-4444-4444-444444444444';
const user = { id: 'user-1', language: 'en' } as UserState;

describe('parseIxButton', () => {
  it('reads a document id and the all marker', () => {
    expect(parseIxButton(`ix:details:${DOC}`)).toEqual({ target: DOC });
    expect(parseIxButton('ix:details:all')).toEqual({ target: 'all' });
  });
  it.each([
    'ix:details:',
    'ix:details:not-a-uuid',
    'ix:other:all',
    'rx:wrong:all',
    'ix:details:a:b',
  ])('rejects %p', (id) => {
    expect(parseIxButton(id)).toBeNull();
  });
});

function setup() {
  const ai = {
    interactionCheck: jest.fn(),
    interactionDetails: jest.fn(),
  };
  const warnings = {
    syncAll: jest.fn().mockResolvedValue({ created: 1, updated: 0, resolved: 0 }),
    listActive: jest.fn().mockResolvedValue([]),
  };
  const users = { activeMedicationSalts: jest.fn().mockResolvedValue([]) };
  const prisma = {
    document: { findFirst: jest.fn().mockResolvedValue({ id: DOC }) },
    medication: { findMany: jest.fn().mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]) },
  };
  const logger = { setContext: jest.fn(), info: jest.fn() };
  const session = {
    requestId: 'req-1',
    text: jest.fn().mockResolvedValue(undefined),
    textAt: jest.fn().mockResolvedValue(undefined),
    rawText: jest.fn().mockResolvedValue(undefined),
    rawButtonsWithPrompt: jest.fn().mockResolvedValue(undefined),
    translate: jest.fn().mockImplementation((key: string) => `T(${key})`),
  };
  const flow = new InteractionFlowService(
    ai as unknown as AiClient,
    warnings as unknown as MedicationWarningsService,
    users as unknown as UsersService,
    prisma as unknown as PrismaService,
    logger as unknown as PinoLogger,
  );
  return {
    flow,
    ai,
    warnings,
    users,
    prisma,
    session,
    asSession: session as unknown as ReplySession,
  };
}

const med = (id: string, saltKey: string | null) => ({
  salt: saltKey ?? '',
  strength: '',
  medication_id: id,
  name: `Name ${id}`,
  salt_key: saltKey,
});

describe('InteractionFlowService.check (CHECK)', () => {
  it('needs two active medicines', async () => {
    const s = setup();
    s.users.activeMedicationSalts.mockResolvedValue([med('m1', 'warfarin')]);
    await expect(s.flow.check(user, s.asSession)).resolves.toBe('check_need_two');
    expect(s.session.text).toHaveBeenCalledWith('check.need_two');
    expect(s.ai.interactionCheck).not.toHaveBeenCalled();
  });

  it('checks ALL stored medicines, saves the result, replies and offers the details button', async () => {
    const s = setup();
    const medications = [med('m1', 'warfarin'), med('m2', 'ibuprofen'), med('m3', null)];
    s.users.activeMedicationSalts.mockResolvedValue(medications);
    const interactions = { findings: [{ type: 'interaction' }], database_ok: true };
    s.ai.interactionCheck.mockResolvedValue({ interactions, reply: { text: 'RESULT' } });

    await expect(s.flow.check(user, s.asSession)).resolves.toBe('check_done');

    expect(s.ai.interactionCheck).toHaveBeenCalledWith({
      request_id: 'req-1-check',
      language: 'en',
      medications,
    });
    expect(s.warnings.syncAll).toHaveBeenCalledWith('user-1', interactions);
    expect(s.session.rawText).toHaveBeenCalledWith('RESULT');
    expect(s.session.rawButtonsWithPrompt).toHaveBeenCalledWith('interaction.details_prompt', [
      { id: 'ix:details:all', title: 'T(interaction.details_button)' },
    ]);
  });

  it('offers no details button when nothing was found', async () => {
    const s = setup();
    s.users.activeMedicationSalts.mockResolvedValue([med('m1', 'a'), med('m2', 'b')]);
    s.ai.interactionCheck.mockResolvedValue({
      interactions: { findings: [], database_ok: true },
      reply: { text: 'none found' },
    });
    await s.flow.check(user, s.asSession);
    expect(s.session.rawButtonsWithPrompt).not.toHaveBeenCalled();
  });

  it('sends ONE error message and rethrows when the AI service fails', async () => {
    const s = setup();
    s.users.activeMedicationSalts.mockResolvedValue([med('m1', 'a'), med('m2', 'b')]);
    s.ai.interactionCheck.mockRejectedValue(new Error('down'));
    await expect(s.flow.check(user, s.asSession)).rejects.toThrow('down');
    expect(s.session.textAt).toHaveBeenCalledWith(99, 'common.error_try_again');
    expect(s.warnings.syncAll).not.toHaveBeenCalled();
  });
});

describe('InteractionFlowService.details', () => {
  const warning = {
    id: 'w1',
    type: 'interaction' as const,
    saltA: 'ibuprofen',
    saltB: 'warfarin',
    severity: 'major' as const,
    medicationIds: ['m1', 'm2'],
    labels: ['Brufen', 'Warf'],
  };

  it('answers a foreign or unknown document neutrally', async () => {
    const s = setup();
    s.prisma.document.findFirst.mockResolvedValue(null);
    await expect(s.flow.details(user, { target: DOC }, s.asSession)).resolves.toBe('ix_not_found');
    expect(s.session.text).toHaveBeenCalledWith('rx.not_found');
    expect(s.prisma.document.findFirst).toHaveBeenCalledWith({
      where: { id: DOC, userId: 'user-1' },
      select: { id: true },
    });
  });

  it('says so when no warning is stored for the document', async () => {
    const s = setup();
    await expect(s.flow.details(user, { target: DOC }, s.asSession)).resolves.toBe('ix_none');
    expect(s.warnings.listActive).toHaveBeenCalledWith('user-1', ['m1', 'm2']);
    expect(s.session.text).toHaveBeenCalledWith('interaction.details_none');
  });

  it('asks the AI service to render the stored warnings, with the unchecked medicines', async () => {
    const s = setup();
    s.warnings.listActive.mockResolvedValue([warning]);
    s.users.activeMedicationSalts.mockResolvedValue([med('m1', 'ibuprofen'), med('m3', null)]);
    s.ai.interactionDetails.mockResolvedValue({ reply: { text: 'DETAILS' } });

    await expect(s.flow.details(user, { target: DOC }, s.asSession)).resolves.toBe('ix_details');

    expect(s.ai.interactionDetails).toHaveBeenCalledWith({
      request_id: 'req-1-ixdetails',
      language: 'en',
      warnings: [
        {
          type: 'interaction',
          salt_a: 'ibuprofen',
          salt_b: 'warfarin',
          labels: ['Brufen', 'Warf'],
        },
      ],
      unchecked: [{ ref: 'm3', label: 'Name m3' }],
      checked_count: 1,
    });
    expect(s.session.rawText).toHaveBeenCalledWith('DETAILS');
  });

  it('all (after CHECK) lists every active warning without a document lookup', async () => {
    const s = setup();
    s.warnings.listActive.mockResolvedValue([warning]);
    s.ai.interactionDetails.mockResolvedValue({ reply: { text: 'ALL' } });
    await s.flow.details(user, { target: 'all' }, s.asSession);
    expect(s.prisma.document.findFirst).not.toHaveBeenCalled();
    expect(s.warnings.listActive).toHaveBeenCalledWith('user-1', undefined);
  });

  it('one error message and a rethrow when rendering fails', async () => {
    const s = setup();
    s.warnings.listActive.mockResolvedValue([warning]);
    s.ai.interactionDetails.mockRejectedValue(new Error('boom'));
    await expect(s.flow.details(user, { target: 'all' }, s.asSession)).rejects.toThrow('boom');
    expect(s.session.textAt).toHaveBeenCalledWith(99, 'common.error_try_again');
  });
});
