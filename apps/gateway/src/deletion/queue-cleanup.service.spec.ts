import {
  type JobLike,
  type QueueLike,
  removeJobsForUser,
  USER_JOB_QUEUES,
} from './queue-cleanup.service';

const USER = 'user-1';

interface FakeJob extends JobLike {
  removed: boolean;
  remove: jest.Mock;
}

function fakeJob(userId: string | undefined, options: { locked?: boolean } = {}): FakeJob {
  const job: FakeJob = {
    data: { userId },
    removed: false,
    remove: jest.fn().mockImplementation(() => {
      if (options.locked) return Promise.reject(new Error('job is locked'));
      job.removed = true;
      return Promise.resolve();
    }),
  };
  return job;
}

function fakeQueue(jobs: FakeJob[]): QueueLike & { getJobs: jest.Mock } {
  return {
    getJobs: jest
      .fn()
      .mockImplementation((_types: readonly string[], start: number, end: number) =>
        Promise.resolve(jobs.slice(start, end + 1)),
      ),
  };
}

describe('removeJobsForUser', () => {
  it("removes only this user's jobs and leaves everyone else's alone", async () => {
    const mine = [fakeJob(USER), fakeJob(USER)];
    const others = [fakeJob('user-2'), fakeJob(undefined), fakeJob('user-3')];
    const queue = fakeQueue([mine[0] as FakeJob, ...others, mine[1] as FakeJob]);

    await expect(removeJobsForUser(queue, USER)).resolves.toBe(2);
    expect(mine.every((job) => job.removed)).toBe(true);
    expect(others.some((job) => job.removed)).toBe(false);
  });

  it('looks in every removable state, including completed and failed (they hold encrypted reply text)', async () => {
    const queue = fakeQueue([]);
    await removeJobsForUser(queue, USER);
    const states = queue.getJobs.mock.calls[0]?.[0] as string[];
    expect(states).toEqual(
      expect.arrayContaining([
        'waiting',
        'delayed',
        'prioritized',
        'paused',
        'completed',
        'failed',
      ]),
    );
    expect(states).not.toContain('active'); // locked by a worker: cannot be removed
  });

  it('pages through large queues without missing jobs (removal happens after paging)', async () => {
    const jobs = Array.from({ length: 450 }, (_, index) =>
      fakeJob(index % 3 === 0 ? USER : 'other'),
    );
    const queue = fakeQueue(jobs);
    const expected = jobs.filter((job) => job.data.userId === USER).length;

    await expect(removeJobsForUser(queue, USER)).resolves.toBe(expected);
    expect(jobs.filter((job) => job.data.userId === USER).every((job) => job.removed)).toBe(true);
    expect(jobs.filter((job) => job.data.userId !== USER).some((job) => job.removed)).toBe(false);
    expect(queue.getJobs.mock.calls.length).toBeGreaterThanOrEqual(3); // 450 jobs, 200 per page
  });

  it('skips a job that is locked or already gone and keeps going', async () => {
    const locked = fakeJob(USER, { locked: true });
    const fine = fakeJob(USER);
    await expect(removeJobsForUser(fakeQueue([locked, fine]), USER)).resolves.toBe(1);
    expect(fine.removed).toBe(true);
  });

  it('returns 0 for an empty queue', async () => {
    await expect(removeJobsForUser(fakeQueue([]), USER)).resolves.toBe(0);
  });
});

describe('USER_JOB_QUEUES (M10)', () => {
  it('includes the reminders queue, so DELETE removes slot, missed, snooze and alert jobs', () => {
    expect(USER_JOB_QUEUES).toEqual(expect.arrayContaining(['inbound', 'outbound', 'reminders']));
  });

  it('removes reminder jobs by the userId every one of them carries', async () => {
    const slot = fakeJob(USER);
    const alert = fakeJob(USER);
    const planner = fakeJob(undefined); // the repeatable planner has no user
    const other = fakeJob('user-2');
    const queue = fakeQueue([slot, planner, alert, other]);
    await expect(removeJobsForUser(queue, USER)).resolves.toBe(2);
    expect(planner.removed).toBe(false);
    expect(other.removed).toBe(false);
  });
});
