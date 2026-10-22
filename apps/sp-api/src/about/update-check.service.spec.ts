import { UpdateCheckService } from './update-check.service';

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

function service(env: NodeJS.ProcessEnv, fetch: jest.Mock) {
  const updates = new UpdateCheckService();
  updates.env = { STASHBOARD_REPOSITORY: 'someone/stashboard', ...env };
  updates.fetch = fetch;
  return updates;
}

function answer(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

describe('UpdateCheckService', () => {
  it('can’t check a build that doesn’t say which repository it came from', async () => {
    const fetch = jest.fn();
    const updates = service(
      { STASHBOARD_COMMIT: COMMIT, STASHBOARD_REPOSITORY: '' },
      fetch,
    );

    await expect(updates.check()).resolves.toMatchObject({
      status: 'unknown',
      reason: 'This build doesn’t say which repository it came from.',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts the commits on main this build is missing', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(answer(200, { status: 'behind', ahead_by: 3 }));
    const updates = service(
      { STASHBOARD_COMMIT: COMMIT, GITHUB_TOKEN: 'token' },
      fetch,
    );

    await expect(updates.check()).resolves.toMatchObject({
      status: 'behind',
      behindBy: 3,
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.github.com/repos/someone/stashboard/compare/${COMMIT}...main`,
    );
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token' });
  });

  it('is up to date when main has nothing newer', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue(answer(200, { status: 'identical', ahead_by: 0 }));

    await expect(
      service({ STASHBOARD_COMMIT: COMMIT }, fetch).check(),
    ).resolves.toMatchObject({ status: 'up-to-date', behindBy: null });
  });

  it('can’t check a local build, and doesn’t ask GitHub', async () => {
    const fetch = jest.fn();

    await expect(
      service({ STASHBOARD_COMMIT: 'dev' }, fetch).check(),
    ).resolves.toMatchObject({ status: 'unknown' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says it can’t check when the private repository hides it', async () => {
    const fetch = jest.fn().mockResolvedValue(answer(404));

    await expect(
      service({ STASHBOARD_COMMIT: COMMIT }, fetch).check(),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('GITHUB_TOKEN'),
    });
  });

  it('fails soft when GitHub can’t be reached, and asks again only after an hour', async () => {
    jest.useFakeTimers();
    try {
      const fetch = jest.fn().mockRejectedValue(new Error('offline'));
      const updates = service({ STASHBOARD_COMMIT: COMMIT }, fetch);

      await expect(updates.check()).resolves.toMatchObject({
        status: 'unknown',
        reason: 'Couldn’t reach GitHub.',
      });
      await updates.check();
      expect(fetch).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(60 * 60_000 + 1);
      await updates.check();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
