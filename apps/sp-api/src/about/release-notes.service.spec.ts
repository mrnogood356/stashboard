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
  it('lists the releases after the one last seen, up to the running one', () => {
    const result = service('1.3.0').since('1.1.0');
    expect(result.current).toBe('1.3.0');
    expect(result.releases.map((release) => release.version)).toEqual([
      '1.3.0',
      '1.2.0',
    ]);
    expect(result.releases[0].features).toEqual(['Thing in 1.3.0']);
  });

  it('has nothing to say on a first visit, the same version, or an edge build', () => {
    expect(service('1.3.0').since(undefined).releases).toEqual([]);
    expect(service('1.3.0').since('1.3.0').releases).toEqual([]);
    expect(service('edge-abc1234').since('1.1.0')).toEqual({
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
    expect(notes.since(undefined).releases.map((r) => r.version)).toEqual([
      '1.4.0',
      '1.3.0',
    ]);
    // A browser that remembers its version still decides.
    expect(notes.since('1.3.0').releases.map((r) => r.version)).toEqual([
      '1.4.0',
    ]);
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
    expect(notes.since(undefined).releases.map((r) => r.version)).toEqual([
      '1.4.0',
    ]);
  });

  it('only starts remembering on a fresh install, and never for edge builds', async () => {
    const create = jest.fn().mockResolvedValue({});
    const fresh = service('1.4.0', {
      appVersionState: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create,
      },
    });
    await fresh.onModuleInit();
    expect(create).toHaveBeenCalledWith({
      data: { key: 'GLOBAL', lastVersion: '1.4.0' },
    });
    expect(fresh.since(undefined).releases).toEqual([]);

    const findUnique = jest.fn();
    await service('edge-abc1234', {
      appVersionState: { findUnique, update: jest.fn(), create: jest.fn() },
    }).onModuleInit();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not stop the app when the version cannot be stored', async () => {
    const notes = service('1.4.0', {
      appVersionState: {
        findUnique: jest.fn().mockRejectedValue(new Error('db down')),
      },
    });
    await expect(notes.onModuleInit()).resolves.toBeUndefined();
    expect(notes.since(undefined).releases).toEqual([]);
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
