import { jobIds } from './reminder.queue';

const USER = '8995aeb8-d147-4936-bdc0-522a9ec74fcb';
const SLOT = new Date('2026-11-10T02:30:00Z');

describe('reminder job ids', () => {
  it('are deterministic (so the planner can run any number of times)', () => {
    expect(jobIds.slot(USER, SLOT)).toBe(`rem_${USER}_1794277800`);
    expect(jobIds.slot(USER, new Date(SLOT))).toBe(jobIds.slot(USER, SLOT));
    expect(jobIds.missed(USER, SLOT)).toBe(`miss_${USER}_1794277800`);
    expect(jobIds.missed(USER, SLOT, 1)).toBe(`miss_${USER}_1794277800_1`);
    expect(jobIds.snooze(USER, SLOT, 2)).toBe(`snz_${USER}_1794277800_2`);
    expect(jobIds.alert(USER, SLOT)).toBe(`alr_${USER}_1794277800`);
  });

  it('never contain ":" (BullMQ forbids it in custom ids) and differ per user, slot and kind', () => {
    const other = new Date('2026-11-10T15:30:00Z');
    const ids = [
      jobIds.slot(USER, SLOT),
      jobIds.slot(USER, other),
      jobIds.slot('another-user', SLOT),
      jobIds.missed(USER, SLOT),
      jobIds.snooze(USER, SLOT, 1),
      jobIds.snooze(USER, SLOT, 2),
      jobIds.alert(USER, SLOT),
      jobIds.caregiverReply('wamid.ABC:1', 'c1'),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => !id.includes(':'))).toBe(true);
  });
});
