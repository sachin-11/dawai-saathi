import type { RedisService } from '../redis/redis.service';
import { PENDING_TTL_SECONDS, PendingStore } from './pending.store';

function setup(scanPages: [string, string[]][] = []): {
  store: PendingStore;
  client: Record<'set' | 'exists' | 'del' | 'scan', jest.Mock>;
} {
  const client = {
    set: jest.fn().mockResolvedValue('OK'),
    exists: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockImplementation((...keys: string[]) => Promise.resolve(keys.length)),
    scan: jest.fn(),
  };
  for (const page of scanPages) client.scan.mockResolvedValueOnce(page);
  return { store: new PendingStore({ client } as unknown as RedisService), client };
}

describe('PendingStore', () => {
  it('uses the key pending:<kind>:<userId>', () => {
    expect(PendingStore.key('delete', 'u1')).toBe('pending:delete:u1');
  });

  it('sets a key that expires after 5 minutes by default', async () => {
    const { store, client } = setup();
    await store.set('delete', 'u1');
    expect(PENDING_TTL_SECONDS).toBe(300);
    expect(client.set).toHaveBeenCalledWith('pending:delete:u1', '1', 'EX', 300);
  });

  it('exists() reflects Redis', async () => {
    const present = setup();
    await expect(present.store.exists('delete', 'u1')).resolves.toBe(true);
    const absent = setup();
    absent.client.exists.mockResolvedValue(0);
    await expect(absent.store.exists('delete', 'u1')).resolves.toBe(false);
  });

  it('clear() deletes the key', async () => {
    const { store, client } = setup();
    await store.clear('delete', 'u1');
    expect(client.del).toHaveBeenCalledWith('pending:delete:u1');
  });

  it('clearAllFor scans every page for pending:*:<userId> and deletes what it finds', async () => {
    const { store, client } = setup([
      ['17', ['pending:delete:u1']],
      ['0', ['pending:other:u1', 'pending:more:u1']],
    ]);
    await expect(store.clearAllFor('u1')).resolves.toBe(3);
    expect(client.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'pending:*:u1', 'COUNT', 100);
    expect(client.scan).toHaveBeenNthCalledWith(2, '17', 'MATCH', 'pending:*:u1', 'COUNT', 100);
    expect(client.del).toHaveBeenCalledTimes(2);
  });

  it('clearAllFor does nothing (and does not call DEL) when there are no keys', async () => {
    const { store, client } = setup([['0', []]]);
    await expect(store.clearAllFor('u1')).resolves.toBe(0);
    expect(client.del).not.toHaveBeenCalled();
  });
});
