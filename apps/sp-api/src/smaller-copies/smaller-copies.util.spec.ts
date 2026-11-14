import {
  DEFAULT_RULES,
  fileResolution,
  inActiveHours,
  needsReplacing,
  pickRelease,
  releaseIsEfficient,
  releaseResolution,
  type CandidateRelease,
  checkNewCopy,
  phashDistance,
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
      duration: 3600,
      studioName: 'Vixen',
    };
    expect(needsReplacing(uhd, rules)).toBe('above-target');
    expect(needsReplacing(uhd, { ...rules, replaceHigher: false })).toBeNull();
    // 10 GB over an hour is lighter than 12 GB an hour: left alone.
    expect(needsReplacing(uhd, { ...rules, minGbPerHour: 12 })).toBeNull();
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
    // 6 GB over half an hour is 12 GB an hour: heavy, while the same file
    // over two hours (3 GB an hour) is fine.
    const big1080 = { width: 1920, height: 1080, size: 6 * GB, duration: 1800 };
    expect(needsReplacing(big1080, rules)).toBeNull();
    expect(needsReplacing(big1080, { ...rules, maxGbPerHour: 8 })).toBe(
      'too-big',
    );
    expect(
      needsReplacing(
        { ...big1080, duration: 7200 },
        { ...rules, maxGbPerHour: 8 },
      ),
    ).toBeNull();
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
    const file = { size: 10 * GB, duration: 3600 };
    expect(pickRelease(releases, file, 'above-target', rules)?.title).toBe(
      'B.1080p',
    );
    expect(
      pickRelease(releases, file, 'above-target', {
        ...rules,
        maxNewGbPerHour: 3,
      })?.title,
    ).toBe('C.1080p');
    // A floor: nothing under 3 GB an hour, too squeezed to swap in.
    expect(
      pickRelease(releases, file, 'above-target', {
        ...rules,
        prefer: 'smallest',
        minNewGbPerHour: 3,
      })?.title,
    ).toBe('B.1080p');
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

  describe('checkNewCopy: the downloaded file, before anything is deleted', () => {
    const old = {
      size: 10 * GB,
      duration: 1800,
      width: 3840,
      height: 2160,
      phash: 'f0f0f0f0f0f0f0f0',
    };
    const good = {
      size: 3 * GB,
      duration: 1801,
      width: 1920,
      height: 1080,
      phash: 'f0f0f0f0f0f0f0f1',
    };

    it('passes the same video at the target, smaller by enough', () => {
      expect(checkNewCopy(old, good, 'above-target', rules)).toBeNull();
    });

    it('keeps both when the picture fingerprint says it’s another video', () => {
      expect(
        checkNewCopy(
          old,
          { ...good, phash: '0f0f0f0f0f0f0f0f' },
          'above-target',
          rules,
        ),
      ).toMatch(/different video/);
    });

    it('falls back to a tight length check without fingerprints', () => {
      const noPrints = { ...good, phash: null };
      expect(checkNewCopy(old, noPrints, 'above-target', rules)).toBeNull();
      // 2 minutes off a 30-minute scene: more than 3%.
      expect(
        checkNewCopy(
          old,
          { ...noPrints, duration: 1920 },
          'above-target',
          rules,
        ),
      ).toMatch(/runs 32 min/);
    });

    it('checks the length even when the pictures match', () => {
      expect(
        checkNewCopy(old, { ...good, duration: 600 }, 'above-target', rules),
      ).toMatch(/runs 10 min/);
    });

    it('keeps both when nothing says it’s the same video', () => {
      expect(
        checkNewCopy(
          { ...old, phash: null, duration: null },
          good,
          'above-target',
          rules,
        ),
      ).toMatch(/no fingerprint or length/);
      // The picture alone is enough when the old length is unknown.
      expect(
        checkNewCopy({ ...old, duration: null }, good, 'above-target', rules),
      ).toBeNull();
    });

    it('keeps both when a size can’t be read', () => {
      expect(
        checkNewCopy(old, { ...good, size: null }, 'above-target', rules),
      ).toMatch(/new file’s size/);
      expect(
        checkNewCopy({ ...old, size: 0 }, good, 'above-target', rules),
      ).toMatch(/old file’s size/);
    });

    it('checks the real file, not what the release name promised', () => {
      expect(
        checkNewCopy(
          old,
          { ...good, width: 1280, height: 720 },
          'above-target',
          rules,
        ),
      ).toMatch(/720p, not the 1080p/);
      expect(
        checkNewCopy(old, { ...good, size: 9.5 * GB }, 'above-target', rules),
      ).toMatch(/saves less than 10%/);
      expect(
        checkNewCopy(old, good, 'above-target', {
          ...rules,
          minNewGbPerHour: 8,
        }),
      ).toMatch(/under the 8 GB floor/);
    });

    it('takes an upgrade only when it really is higher', () => {
      const low = { ...old, width: 1280, height: 720, size: GB };
      expect(checkNewCopy(low, good, 'below-target', rules)).toBeNull();
      expect(
        checkNewCopy(
          low,
          { ...good, width: 1280, height: 720 },
          'below-target',
          rules,
        ),
      ).toMatch(/no better than the old 720p/);
    });

    it('measures fingerprints bit by bit', () => {
      expect(phashDistance('ff', 'fe')).toBe(1);
      expect(phashDistance('ff', null)).toBeNull();
      expect(phashDistance('zz', 'ff')).toBeNull();
    });
  });
});
