import {
  DEFAULT_RULES,
  fileResolution,
  inActiveHours,
  needsReplacing,
  pickRelease,
  releaseIsEfficient,
  releaseResolution,
  type CandidateRelease,
} from './smaller-copies.util';

const GB = 1024 ** 3;
const rules = DEFAULT_RULES;
const release = (
  title: string,
  size: number,
  extra: Partial<CandidateRelease> = {},
) => ({
  guid: title,
  indexerId: 1,
  title,
  size,
  protocol: 'usenet' as const,
  match: { strength: 'strong' as const },
  ...extra,
});

describe('smaller copies', () => {
  it('reads resolutions and codecs from release titles, and resolutions from files', () => {
    expect(releaseResolution('Studio.24.03.15.Jane.Doe.2160p.MP4-XXX')).toBe(
      '2160p',
    );
    expect(releaseResolution('Studio 4K Jane Doe')).toBe('2160p');
    expect(releaseResolution('Studio.24.03.15.Jane.Doe.1080p.HEVC')).toBe(
      '1080p',
    );
    expect(releaseResolution('Studio.Jane.Doe.720p')).toBe('720p');
    expect(releaseResolution('Studio.Jane.Doe')).toBeNull();
    expect(releaseIsEfficient('A.1080p.x265')).toBe(true);
    expect(releaseIsEfficient('A.1080p.H.265')).toBe(true);
    expect(releaseIsEfficient('A.1080p.x264')).toBe(false);
    expect(fileResolution(3840, 2160)).toBe('2160p');
    expect(fileResolution(1080, 1920)).toBe('1080p');
    expect(fileResolution(null, null)).toBeNull();
  });

  it('picks which files to look for by resolution, size and studio', () => {
    const uhd = {
      width: 3840,
      height: 2160,
      size: 10 * GB,
      studioName: 'Vixen',
    };
    expect(needsReplacing(uhd, rules)).toBe('above-target');
    expect(needsReplacing(uhd, { ...rules, replaceHigher: false })).toBeNull();
    expect(needsReplacing(uhd, { ...rules, minFileSizeGb: 12 })).toBeNull();
    expect(
      needsReplacing(uhd, {
        ...rules,
        studioMode: 'skip',
        studioNames: ['vixen'],
      }),
    ).toBeNull();
    expect(
      needsReplacing(uhd, {
        ...rules,
        studioMode: 'only',
        studioNames: ['Blacked'],
      }),
    ).toBeNull();
    expect(
      needsReplacing(uhd, {
        ...rules,
        studioMode: 'only',
        studioNames: ['VIXEN'],
      }),
    ).toBe('above-target');
    const hd720 = { width: 1280, height: 720, size: GB };
    expect(needsReplacing(hd720, rules)).toBeNull();
    expect(needsReplacing(hd720, { ...rules, upgradeLower: true })).toBe(
      'below-target',
    );
    const big1080 = { width: 1920, height: 1080, size: 6 * GB };
    expect(needsReplacing(big1080, rules)).toBeNull();
    expect(needsReplacing(big1080, { ...rules, maxFileSizeGb: 4 })).toBe(
      'too-big',
    );
  });

  it('grabs a usenet match at the target that saves enough and fits the cap, biggest first', () => {
    const releases = [
      release('A.2160p', 8 * GB),
      release('B.1080p', 4 * GB),
      release('C.1080p', 2.5 * GB),
      release('D.1080p', 3 * GB, { match: { strength: 'partial' } }),
      release('E.1080p', 3.5 * GB, { protocol: 'torrent' }),
      release('F.1080p', 9.5 * GB),
    ];
    const file = { size: 10 * GB };
    expect(pickRelease(releases, file, 'above-target', rules)?.title).toBe(
      'B.1080p',
    );
    expect(
      pickRelease(releases, file, 'above-target', { ...rules, maxNewSizeGb: 3 })
        ?.title,
    ).toBe('C.1080p');
    expect(
      pickRelease(releases, file, 'above-target', {
        ...rules,
        prefer: 'smallest',
      })?.title,
    ).toBe('C.1080p');
    // A partial match only when allowed, and a strong one still wins.
    expect(
      pickRelease([releases[3]], file, 'above-target', {
        ...rules,
        matchStrength: 'partial',
      })?.title,
    ).toBe('D.1080p');
    expect(pickRelease([releases[3]], file, 'above-target', rules)).toBeNull();
    // Not enough saved.
    expect(
      pickRelease([release('X.1080p', 9.5 * GB)], file, 'above-target', rules),
    ).toBeNull();
    expect(
      pickRelease([release('X.1080p', 7.5 * GB)], file, 'above-target', {
        ...rules,
        minSavingsPercent: 30,
      }),
    ).toBeNull();
    // An upgrade can be bigger.
    expect(
      pickRelease(
        [release('U.1080p', 3 * GB)],
        { size: GB },
        'below-target',
        rules,
      )?.title,
    ).toBe('U.1080p');
  });

  it('prefers or insists on HEVC and AV1 when asked', () => {
    const releases = [
      release('A.1080p.x264', 4 * GB),
      release('B.1080p.x265', 2 * GB),
    ];
    const file = { size: 10 * GB };
    expect(pickRelease(releases, file, 'above-target', rules)?.title).toBe(
      'A.1080p.x264',
    );
    expect(
      pickRelease(releases, file, 'above-target', {
        ...rules,
        codec: 'prefer-efficient',
      })?.title,
    ).toBe('B.1080p.x265');
    expect(
      pickRelease([releases[0]], file, 'above-target', {
        ...rules,
        codec: 'efficient-only',
      }),
    ).toBeNull();
  });

  it('keeps to the active hours, including a window over midnight', () => {
    expect(inActiveHours(3, null, null)).toBe(true);
    expect(inActiveHours(3, 1, 6)).toBe(true);
    expect(inActiveHours(7, 1, 6)).toBe(false);
    expect(inActiveHours(23, 22, 6)).toBe(true);
    expect(inActiveHours(12, 22, 6)).toBe(false);
  });
});
