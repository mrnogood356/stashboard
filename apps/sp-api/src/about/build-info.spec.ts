import { resolveBuildInfo } from './build-info';

describe('resolveBuildInfo', () => {
  it('reads the commit and build time the image was built with', () => {
    expect(
      resolveBuildInfo({
        STASHBOARD_COMMIT: 'ABC1234DEF',
        STASHBOARD_BUILT_AT: '2026-10-20T12:00:00Z',
      }),
    ).toMatchObject({
      commit: 'abc1234def',
      builtAt: '2026-10-20T12:00:00.000Z',
    });
  });

  it('reads the repository the image was built from, if it looks like one', () => {
    expect(
      resolveBuildInfo({ STASHBOARD_REPOSITORY: 'someone/stashboard' })
        .repository,
    ).toBe('someone/stashboard');
    expect(
      resolveBuildInfo({ STASHBOARD_REPOSITORY: '' }).repository,
    ).toBeNull();
    expect(
      resolveBuildInfo({ STASHBOARD_REPOSITORY: 'https://evil.example/x' })
        .repository,
    ).toBeNull();
  });

  it('gives no commit or build time for a local build', () => {
    expect(
      resolveBuildInfo({
        STASHBOARD_COMMIT: 'dev',
        STASHBOARD_BUILT_AT: 'dev',
      }),
    ).toMatchObject({ commit: null, builtAt: null });
    expect(resolveBuildInfo({})).toMatchObject({
      commit: null,
      builtAt: null,
    });
  });
});
