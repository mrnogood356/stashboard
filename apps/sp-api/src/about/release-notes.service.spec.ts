import { ReleaseNotesService } from './release-notes.service';

const CHANGELOG = ['1.4.0', '1.3.0', '1.2.0', '1.1.0']
  .map(
    (version) =>
      `## [${version}](x) (2026-10-01)\n\n### Features\n\n* thing in ${version}\n`,
  )
  .join('\n');

function service(version: string): ReleaseNotesService {
  const notes = new ReleaseNotesService();
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
});
