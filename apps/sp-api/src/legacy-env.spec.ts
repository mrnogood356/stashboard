import { applyLegacyEnv } from './legacy-env';

describe('applyLegacyEnv', () => {
  it('fills each new STASHBOARD_ setting from its old STASHARR_ name', () => {
    const env: NodeJS.ProcessEnv = {
      STASHARR_LOG_LEVELS: 'error,warn',
      STASHARR_UPDATE_REPO: 'old/repo',
      STASHBOARD_UPDATE_REPO: 'new/repo',
    };

    expect(applyLegacyEnv(env)).toEqual(['STASHARR_LOG_LEVELS']);
    expect(env.STASHBOARD_LOG_LEVELS).toBe('error,warn');
    // The new name wins when both are set.
    expect(env.STASHBOARD_UPDATE_REPO).toBe('new/repo');
  });
});
