import type { PinoLogger } from 'nestjs-pino';

import type { MessagesService } from './messages.service';
import { StatusUpdater } from './status-updater.service';

function setup(results: ('updated' | 'ignored' | 'not_found')[]): {
  updater: StatusUpdater;
  applyStatus: jest.Mock;
} {
  const applyStatus = jest.fn();
  for (const result of results) applyStatus.mockResolvedValueOnce(result);
  applyStatus.mockResolvedValue('not_found');
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const updater = new StatusUpdater(
    { applyStatus } as unknown as MessagesService,
    logger as unknown as PinoLogger,
  );
  return { updater, applyStatus };
}

const update = {
  waMessageId: 'wamid.OUT1',
  status: 'delivered',
  timestamp: new Date('2026-11-07T10:00:00Z'),
};

describe('StatusUpdater', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes the status, the Meta timestamp and the error code to the message store', async () => {
    const { updater, applyStatus } = setup(['updated']);
    await updater.apply({
      waMessageId: 'wamid.OUT2',
      status: 'failed',
      errorCode: 131047,
      timestamp: update.timestamp,
    });
    expect(applyStatus).toHaveBeenCalledWith({
      waMessageId: 'wamid.OUT2',
      status: 'failed',
      at: update.timestamp,
      errorCode: '131047',
    });
  });

  it('ignores statuses we do not model (e.g. "deleted") without touching the database', async () => {
    const { updater, applyStatus } = setup([]);
    await updater.apply({ waMessageId: 'wamid.OUT1', status: 'deleted' });
    expect(applyStatus).not.toHaveBeenCalled();
  });

  it('does not retry when the update was applied or deliberately ignored (out of order)', async () => {
    jest.useFakeTimers();
    for (const result of ['updated', 'ignored'] as const) {
      const { updater, applyStatus } = setup([result]);
      await updater.apply(update);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(applyStatus).toHaveBeenCalledTimes(1);
      updater.onModuleDestroy();
    }
  });

  it('retries when the outbound row is not there yet (receipt beat our own insert)', async () => {
    jest.useFakeTimers();
    const { updater, applyStatus } = setup(['not_found', 'not_found', 'updated']);
    await updater.apply(update);
    expect(applyStatus).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(applyStatus).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(applyStatus).toHaveBeenCalledTimes(3); // 'updated': stops here
    await jest.advanceTimersByTimeAsync(60_000);
    expect(applyStatus).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last retry for a message that never appears', async () => {
    jest.useFakeTimers();
    const { updater, applyStatus } = setup([]); // always not_found
    await updater.apply(update);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(applyStatus).toHaveBeenCalledTimes(4); // first try + 3 retries
  });

  it('cancels pending retries on shutdown', async () => {
    jest.useFakeTimers();
    const { updater, applyStatus } = setup([]);
    await updater.apply(update);
    updater.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(applyStatus).toHaveBeenCalledTimes(1);
  });

  it('a database failure on the first attempt propagates (the webhook answers 500, Meta retries)', async () => {
    const { updater, applyStatus } = setup([]);
    applyStatus.mockReset();
    applyStatus.mockRejectedValue(new Error('db down'));
    await expect(updater.apply(update)).rejects.toThrow('db down');
  });
});
