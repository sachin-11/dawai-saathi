import type { CryptoService } from '../common/crypto/crypto.service';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { ReminderQueue } from '../reminders/reminder.queue';
import type { InboundMessage } from '../webhook/inbound-message';
import { CaregiverInboundService } from './caregiver-inbound.service';
import type { CaregiversService } from './caregivers.service';

const NOW = new Date('2026-11-10T10:00:00Z');
const message = (
  text: string | undefined,
  type: InboundMessage['type'] = 'text',
): InboundMessage => ({
  waMessageId: 'wamid.X1',
  from: '919876543210',
  timestamp: NOW,
  type,
  ...(text === undefined ? {} : { text }),
});

function setup(
  rows: { id: string; userId: string; status: 'pending' | 'verified' }[],
  userExists = false,
) {
  const findByPhone = jest.fn().mockResolvedValue(rows.map((row) => ({ ...row, invitedAt: NOW })));
  const touchInbound = jest.fn().mockResolvedValue(undefined);
  const addCaregiverReply = jest.fn().mockResolvedValue(undefined);
  const service = new CaregiverInboundService(
    { findByPhone, touchInbound } as unknown as CaregiversService,
    { addCaregiverReply } as unknown as ReminderQueue,
    {
      user: { findUnique: jest.fn().mockResolvedValue(userExists ? { id: 'u' } : null) },
    } as unknown as PrismaService,
    { hashPhone: (phone: string) => `h:${phone}` } as unknown as CryptoService,
  );
  return { service, findByPhone, touchInbound, addCaregiverReply };
}

describe('CaregiverInboundService', () => {
  it("ignores a number that is nobody's caregiver (normal onboarding follows)", async () => {
    const s = setup([]);
    expect(await s.service.tryHandle(message('YES'))).toBe(false);
    expect(s.touchInbound).not.toHaveBeenCalled();
    expect(s.addCaregiverReply).not.toHaveBeenCalled();
  });

  it('hands YES from a pending caregiver to the worker and opens their 24 h window', async () => {
    const s = setup([{ id: 'c1', userId: 'u1', status: 'pending' }]);
    expect(await s.service.tryHandle(message('Haan'))).toBe(true);
    expect(s.touchInbound).toHaveBeenCalledWith(['c1'], NOW);
    expect(s.addCaregiverReply).toHaveBeenCalledWith({
      userId: 'u1',
      caregiverId: 'c1',
      reply: 'yes',
      waMessageId: 'wamid.X1',
    });
  });

  it('answers every pending invite of the same number, but YES means nothing for a verified one', async () => {
    const s = setup([
      { id: 'c1', userId: 'u1', status: 'pending' },
      { id: 'c2', userId: 'u2', status: 'verified' },
    ]);
    expect(await s.service.tryHandle(message('YES'))).toBe(true);
    expect(s.addCaregiverReply).toHaveBeenCalledTimes(1);
    expect(s.addCaregiverReply.mock.calls[0]?.[0]).toMatchObject({ caregiverId: 'c1' });
  });

  it('STOP ALERTS applies to pending and verified rows', async () => {
    const s = setup([
      { id: 'c1', userId: 'u1', status: 'pending' },
      { id: 'c2', userId: 'u2', status: 'verified' },
    ]);
    expect(await s.service.tryHandle(message('STOP ALERTS'))).toBe(true);
    expect(s.addCaregiverReply).toHaveBeenCalledTimes(2);
  });

  it('a bare STOP means stop alerts only for someone who is not also a user', async () => {
    const onlyCaregiver = setup([{ id: 'c1', userId: 'u1', status: 'verified' }], false);
    expect(await onlyCaregiver.service.tryHandle(message('stop'))).toBe(true);
    const alsoUser = setup([{ id: 'c1', userId: 'u1', status: 'verified' }], true);
    expect(await alsoUser.service.tryHandle(message('stop'))).toBe(false);
    expect(alsoUser.addCaregiverReply).not.toHaveBeenCalled();
  });

  it('anything else from a caregiver falls through to the normal flow (but still opens the window)', async () => {
    const s = setup([{ id: 'c1', userId: 'u1', status: 'verified' }]);
    expect(await s.service.tryHandle(message('hello, how does this work?'))).toBe(false);
    expect(s.touchInbound).toHaveBeenCalled();
    expect(s.addCaregiverReply).not.toHaveBeenCalled();
  });

  it('only text messages are caregiver answers', async () => {
    const s = setup([{ id: 'c1', userId: 'u1', status: 'pending' }]);
    expect(await s.service.tryHandle(message(undefined, 'image'))).toBe(false);
    expect(s.findByPhone).not.toHaveBeenCalled();
  });
});
