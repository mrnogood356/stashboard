import { ReleaseNotesService } from './release-notes.service';

const CHANGELOG = ['1.4.0', '1.3.0', '1.2.0', '1.1.0']
  .map(
    (version) =>
      `## [${version}](x) (2026-10-01)\n\n### Features\n\n* thing in ${version}\n`,
  )
  .join('\n');

function service(version: string, prisma?: unknown): ReleaseNotesService {
  const notes = new ReleaseNotesService(prisma as never);
  notes.version = () => version;
  notes.changelog = () => CHANGELOG;
  return notes;
}

describe('ReleaseNotesService', () => {
  it('lists the releases after the one last seen, up to the running one', async () => {
    const result = await service('1.3.0').since('1.1.0');
    expect(result.current).toBe('1.3.0');
    expect(result.releases.map((release) => release.version)).toEqual([
      '1.3.0',
      '1.2.0',
    ]);
    expect(result.releases[0].features).toEqual(['Thing in 1.3.0']);
  });

  it('has nothing to say on a first visit, the same version, or an edge build', async () => {
    expect((await service('1.3.0').since(undefined)).releases).toEqual([]);
    expect((await service('1.3.0').since('1.3.0')).releases).toEqual([]);
    expect(await service('edge-abc1234').since('1.1.0')).toEqual({
      current: 'edge-abc1234',
      releases: [],
    });
  });

  it('answers a browser that remembers no version with the release this server ran before', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      appVersionState: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ lastVersion: '1.2.0', previousVersion: null }),
        update,
        create: jest.fn(),
      },
    };
    const notes = service('1.4.0', prisma);
    await notes.onModuleInit();

    expect(update).toHaveBeenCalledWith({
      where: { key: 'GLOBAL' },
      data: { lastVersion: '1.4.0', previousVersion: '1.2.0' },
    });
    expect(
      (await notes.since(undefined)).releases.map((r) => r.version),
    ).toEqual(['1.4.0', '1.3.0']);
    // A browser that remembers its version still decides.
    expect((await notes.since('1.3.0')).releases.map((r) => r.version)).toEqual(
      ['1.4.0'],
    );
  });

  it('keeps the earlier release across restarts of the same one', async () => {
    const update = jest.fn();
    const notes = service('1.4.0', {
      appVersionState: {
        findUnique: jest.fn().mockResolvedValue({
          lastVersion: '1.4.0',
          previousVersion: '1.3.0',
        }),
        update,
        create: jest.fn(),
      },
    });
    await notes.onModuleInit();

    expect(update).not.toHaveBeenCalled();
    expect(
      (await notes.since(undefined)).releases.map((r) => r.version),
    ).toEqual(['1.4.0']);
  });

  it('only starts remembering on a fresh install, and never for edge builds', async () => {
    const create = jest.fn().mockResolvedValue({});
    const fresh = service('1.4.0', {
      adminUser: { count: jest.fn().mockResolvedValue(0) },
      appVersionState: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create,
      },
    });
    await fresh.onModuleInit();
    expect(create).toHaveBeenCalledWith({
      data: { key: 'GLOBAL', lastVersion: '1.4.0', previousVersion: null },
    });
    expect((await fresh.since(undefined)).releases).toEqual([]);

    const findUnique = jest.fn();
    await service('edge-abc1234', {
      appVersionState: { findUnique, update: jest.fn(), create: jest.fn() },
    }).onModuleInit();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('on an existing install’s first start with this, counts the release before as the earlier one', async () => {
    const create = jest.fn().mockResolvedValue({});
    const notes = service('1.4.0', {
      adminUser: { count: jest.fn().mockResolvedValue(1) },
      appVersionState: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create,
      },
    });
    await notes.onModuleInit();

    expect(create).toHaveBeenCalledWith({
      data: { key: 'GLOBAL', lastVersion: '1.4.0', previousVersion: '1.3.0' },
    });
    expect(
      (await notes.since(undefined)).releases.map((r) => r.version),
    ).toEqual(['1.4.0']);
  });

  it('shows an update’s notes once, even to a browser that forgot what it saw', async () => {
    let state: Record<string, unknown> = {
      lastVersion: '1.4.0',
      previousVersion: '1.3.0',
      notesSeenVersion: null,
    };
    const upsert = jest.fn((args: { update: Record<string, unknown> }) => {
      state = { ...state, ...args.update };
      return Promise.resolve(state);
    });
    const notes = service('1.4.0', {
      appVersionState: {
        findUnique: jest.fn(() => Promise.resolve(state)),
        update: jest.fn(),
        create: jest.fn(),
        upsert,
      },
    });
    await notes.onModuleInit();
    expect((await notes.since(undefined)).releases).toHaveLength(1);

    await notes.markSeen('1.4.0');
    expect(upsert).toHaveBeenCalledTimes(1);
    // A browser with no version, or an older one, gets nothing again.
    expect((await notes.since(undefined)).releases).toEqual([]);
    expect((await notes.since('1.2.0')).releases).toEqual([]);
    // An older or newer-than-running version is never stored.
    await notes.markSeen('1.3.0');
    await notes.markSeen('9.0.0');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('says nothing when it can’t tell whether notes were closed, and stores only releases it runs', async () => {
    const failing = service('1.4.0', {
      appVersionState: {
        findUnique: jest.fn().mockRejectedValue(new Error('db down')),
        upsert: jest.fn(),
      },
    });
    expect((await failing.since('1.2.0')).releases).toEqual([]);
    // A close that can't be checked fails, so the browser tries again.
    await expect(failing.markSeen('1.4.0')).rejects.toThrow('db down');

    const upsert = jest.fn();
    const edge = service('edge-abc1234', {
      appVersionState: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert,
      },
    });
    await edge.markSeen('1.4.0');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('never lets an older close replace a newer one that arrived together', async () => {
    let state: Record<string, unknown> = { notesSeenVersion: '1.2.0' };
    const findUnique = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(state), 5)),
    );
    const upsert = jest.fn((args: { update: Record<string, unknown> }) => {
      state = { ...state, ...args.update };
      return Promise.resolve(state);
    });
    const notes = service('1.4.0', {
      appVersionState: { findUnique, upsert },
    });
    await Promise.all([notes.markSeen('1.4.0'), notes.markSeen('1.3.0')]);
    expect(state['notesSeenVersion']).toBe('1.4.0');
  });

  it('does not stop the app when the version cannot be stored', async () => {
    const notes = service('1.4.0', {
      appVersionState: {
        findUnique: jest.fn().mockRejectedValue(new Error('db down')),
      },
    });
    await expect(notes.onModuleInit()).resolves.toBeUndefined();
    expect((await notes.since(undefined)).releases).toEqual([]);
  });

  it('gives the running release its own notes for About', () => {
    expect(
      service('1.3.0')
        .latest()
        .releases.map((r) => r.version),
    ).toEqual(['1.3.0']);
    expect(
      service('1.9.0')
        .latest()
        .releases.map((r) => r.version),
    ).toEqual(['1.4.0']);
  });
});
