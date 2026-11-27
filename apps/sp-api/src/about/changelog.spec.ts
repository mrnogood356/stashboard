import { join } from 'node:path';
import { compareVersions, parseChangelog, readChangelog } from './changelog';

const SAMPLE = `# Changelog

## [1.3.0](https://github.com/o/r/compare/v1.2.0...v1.3.0) (2026-10-29)


### Features

* **appearance:** make the artwork backdrop its own Adaptive glass style ([cc7adac](https://github.com/o/r/commit/cc7adac7468ff09703ebe0152cc1b9dc029068ca))
* show Whisparr's scenes on the calendar too ([51c1608](https://github.com/o/r/commit/51c1608978116ce28b7cc5a8a93d7d8d2fe2be8c))
* show Whisparr's scenes on the calendar too ([3f5a85a](https://github.com/o/r/commit/3f5a85a9a98effc4de0314e4a263b95433509561))


### Bug Fixes

* address review on the calendar, Tools hub and match cards ([74cd7e9](https://github.com/o/r/commit/74cd7e9f29ced72e8a1640e96809a540d96f362f))
* **calendar:** ask the catalog for the month, closes [#12](https://github.com/o/r/issues/12) ([9d68337](https://github.com/o/r/commit/9d68337e09c0b52f8f7da3b8a813336a6b52df9b))

## 1.2.0 (2026-10-28)

### Features

* a release calendar

### Miscellaneous Chores

* bump things
`;

describe('parseChangelog', () => {
  it('reads each release as plain sentences', () => {
    expect(parseChangelog(SAMPLE)).toEqual([
      {
        version: '1.3.0',
        date: '2026-10-29',
        features: [
          'Make the artwork backdrop its own Adaptive glass style',
          "Show Whisparr's scenes on the calendar too",
        ],
        fixes: ['Ask the catalog for the month'],
      },
      {
        version: '1.2.0',
        date: '2026-10-28',
        features: ['A release calendar'],
        fixes: [],
      },
    ]);
  });

  it('reads tidied notes: their own headings, areas kept, no PR links or bold', () => {
    const tidied = `## [1.7.5](https://github.com/o/r/compare/v1.7.4...v1.7.5) (2026-11-27)


### Security

* **Changes sent from another app on the same host are refused.** Your login keeps other websites out. ([#126](https://github.com/o/r/pull/126))

### Fixed

* **Requests:** a scene you want shows SABnzbd's own progress. ([#126](https://github.com/o/r/pull/126))
* **Library:** the pickers search for \`%\` as typed. ([#125](https://github.com/o/r/pull/125))
* **Drop-ins:** a file matched later is still put in its folder. ([#119](https://github.com/o/r/pull/119), [#120](https://github.com/o/r/pull/120))

## [1.7.4](https://github.com/o/r/compare/v1.7.3...v1.7.4) (2026-11-25)

### New

* **Requests:** pick a release yourself.

### Faster

* Home opens quicker on phones.

### Changes Behind The Scenes

* not for the dialog
`;
    expect(parseChangelog(tidied)).toEqual([
      {
        version: '1.7.5',
        date: '2026-11-27',
        features: [],
        fixes: [
          'Changes sent from another app on the same host are refused. Your login keeps other websites out.',
          "Requests: a scene you want shows SABnzbd's own progress.",
          'Library: the pickers search for % as typed.',
          'Drop-ins: a file matched later is still put in its folder.',
        ],
      },
      {
        version: '1.7.4',
        date: '2026-11-25',
        features: [
          'Requests: pick a release yourself.',
          'Home opens quicker on phones.',
        ],
        fixes: [],
      },
    ]);
  });

  it('reads the changelog that ships with Stashboard', () => {
    const text = readChangelog(join(__dirname, '..'));
    expect(text).not.toBeNull();
    const releases = parseChangelog(text ?? '');
    expect(releases.length).toBeGreaterThan(0);
    expect(releases[0].version).toMatch(/^\d+\.\d+\.\d+$/);
    // The latest release has something to show in "What's new".
    expect(
      releases[0].features.length + releases[0].fixes.length,
    ).toBeGreaterThan(0);
  });
});

describe('compareVersions', () => {
  it('compares x.y.z numerically and refuses anything else', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBe(1);
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.2.1')).toBe(-1);
    expect(compareVersions('edge-abc1234', '1.2.0')).toBeNull();
  });
});
