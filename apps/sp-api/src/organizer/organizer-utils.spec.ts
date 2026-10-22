import type { StashdbMatchScene } from '../providers/stashdb/stashdb.adapter';
import { parseFileName, scoreByName } from './match-scoring.util';
import {
  dedupeTargets,
  inSceneFolder,
  isUnderFolder,
  planRename,
  whisparrFolderFor,
  whisparrFolderFormat,
} from './organizer.service';
import {
  findRoot,
  formatPerformers,
  formatResolution,
  joinPath,
  qualityTitle,
  releaseGroup,
  renderPattern,
  studioSlug,
  sanitize,
  splitPath,
  validatePattern,
} from './rename.util';

function candidate(
  overrides: Partial<StashdbMatchScene> = {},
): StashdbMatchScene {
  return {
    id: 'remote-1',
    title: 'Summer Afternoon',
    code: null,
    details: null,
    director: null,
    date: '2023-08-14',
    duration: 1800,
    imageUrl: null,
    studio: { id: 's1', name: 'Bright Studio' },
    performers: [
      {
        id: 'p1',
        name: 'Jane Doe',
        as: null,
        disambiguation: null,
        gender: 'FEMALE',
      },
    ],
    tags: [],
    urls: [],
    ...overrides,
  };
}

describe('parseFileName', () => {
  it('pulls out the date and drops quality and group junk', () => {
    const parsed = parseFileName(
      'BrightStudio.23.08.14.Jane.Doe.Summer.Afternoon.XXX.1080p.MP4-KTR.mp4',
    );
    expect(parsed.date).toBe('2023-08-14');
    expect(parsed.text).toBe('bright studio jane doe summer afternoon');
  });

  it('reads long dates', () => {
    expect(parseFileName('Bright Studio - 2021-02-03 - Title.mkv').date).toBe(
      '2021-02-03',
    );
  });

  it('uses the folder when the file name says nothing', () => {
    const parsed = parseFileName(
      'a1b2c3d4e5f6a7b8.mp4',
      'Bright Studio - Summer Afternoon',
    );
    expect(parsed.text).toBe('bright studio summer afternoon');
  });
});

describe('scoreByName', () => {
  it('rates a matching name, date, studio and length as strong', () => {
    const parsed = parseFileName(
      'BrightStudio.23.08.14.Jane.Doe.Summer.Afternoon.1080p.mp4',
    );
    const result = scoreByName(parsed, 1801, candidate());
    expect(result.confidence).toBe('strong');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'Same length',
        'Title in file name',
        'Studio in file name',
        'Same date',
        'Performer in file name',
      ]),
    );
  });

  it('finds studio and performer names written in other scripts', () => {
    const parsed = parseFileName(
      '[ムーディーズ] 2023-08-14 天使もえ 夏の午後.mp4',
    );
    const result = scoreByName(
      parsed,
      null,
      candidate({
        title: '夏の午後',
        studio: { id: 's1', name: 'ムーディーズ' },
        performers: [
          {
            id: 'p1',
            name: '天使もえ',
            as: null,
            disambiguation: null,
            gender: 'FEMALE',
          },
        ],
      }),
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining(['Studio in file name', 'Performer in file name']),
    );
  });

  it('marks a very different length down', () => {
    const parsed = parseFileName('Summer.Afternoon.mp4');
    const result = scoreByName(parsed, 600, candidate());
    expect(result.reasons).toContain('Different length');
    expect(result.confidence).toBe('weak');
  });
});

describe('rename patterns', () => {
  it('takes a naming format copied from Whisparr as is', () => {
    expect(
      validatePattern(
        'scenes/{Studio Title}/{Release Date} - {Scene Title}/{Studio CleanTitleSlug}.{Scene.CleanTitle}.{Release Date}{.Quality.Title}{-Release Group}',
      ),
    ).toBeNull();
    expect(validatePattern('{studio}/{title} {Nonsense}')).toContain(
      'Unknown placeholder {Nonsense}',
    );
    expect(validatePattern('{Studio Title}/{Release Date}')).toContain(
      'file name part',
    );
    expect(validatePattern('{Studio CleanNetwork}/{Scene Title}')).toContain(
      "needs Whisparr's own data",
    );
  });

  it('names files the way Whisparr does', () => {
    const pattern = '{studioslug}.{title}.{date}.{quality}-{group}';
    expect(
      renderPattern(pattern, {
        studioslug: studioSlug('Bright Studio'),
        title: "Summer's Day: Part 2",
        date: '2023-08-14',
        quality: qualityTitle('bright.summer.WEB-DL.1080p-GRP.mp4', '1080p'),
        group: releaseGroup('bright.summer.WEB-DL.1080p-GRP.mp4'),
      })?.name,
    ).toBe('BrightStudio.Summers.Day.Part.2.2023-08-14.WEBDL-1080p-GRP');
    // No release group: it and its separator go. No source: WEB-DL, as Whisparr assumes.
    expect(
      renderPattern(pattern, {
        studioslug: 'BrightStudio',
        title: 'Rooftop',
        date: '2023-08-14',
        quality: qualityTitle('Rooftop.mp4', '720p'),
        group: releaseGroup('Rooftop.mp4'),
      })?.name,
    ).toBe('BrightStudio.Rooftop.2023-08-14.WEBDL-720p');
  });

  it('finds a release group only at the end of a scene-style name', () => {
    expect(releaseGroup('Studio.Title.2160p-XLeech.mkv')).toBe('XLeech');
    expect(releaseGroup('Studio.Title.WEB-DL.mp4')).toBe('');
    expect(releaseGroup('My Scene - Part 2.mp4')).toBe('');
  });

  it('fills the pattern and keeps folders', () => {
    expect(
      renderPattern('{studio}/{date} - {title}', {
        studio: 'Bright Studio',
        date: '2023-08-14',
        title: 'Summer: Part 1',
      }),
    ).toEqual({
      folders: ['Bright Studio'],
      name: '2023-08-14 - Summer - Part 1',
    });
  });

  it('drops separators next to empty placeholders', () => {
    expect(
      renderPattern('{studio} - {date} - {title} ({year})', {
        studio: 'S',
        title: 'T',
      })?.name,
    ).toBe('S - T');
    expect(
      renderPattern('{date} - {title}', { title: 'Hey... You' })?.name,
    ).toBe('Hey... You');
  });

  it('puts files with no studio in Unsorted', () => {
    expect(renderPattern('{studio}/{title}', { title: 'T' })?.folders).toEqual([
      'Unsorted',
    ]);
  });

  it('returns null when the file name would be empty', () => {
    expect(renderPattern('{studio}/{title}', { studio: 'S' })).toBeNull();
  });

  it('removes characters that are not allowed in file names', () => {
    expect(sanitize('A/B\\C*D?E"F<G>H|I')).toBe('ABCDEFGHI');
  });

  it('checks patterns', () => {
    expect(validatePattern('{studio}/{date} - {title}')).toBeNull();
    expect(validatePattern('/abs/{title}')).toMatch(/relative/);
    expect(validatePattern('../{title}')).toMatch(/up a folder/);
    expect(validatePattern('{studio}/{nope}')).toMatch(/Unknown placeholder/);
    expect(validatePattern('{title}/{studio}')).toMatch(/file name part/);
  });

  it('formats performers and resolution', () => {
    expect(formatPerformers(['A', 'B', 'C'])).toBe('A, B & C');
    expect(formatPerformers(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C +2');
    expect(formatResolution(1920, 1080)).toBe('1080p');
    expect(formatResolution(1080, 1920)).toBe('1080p');
    expect(formatResolution(3840, 2076)).toBe('2160p');
  });

  it('handles paths', () => {
    expect(splitPath('/data/a/b.MP4')).toEqual({
      folder: '/data/a',
      basename: 'b.MP4',
      extension: '.mp4',
      separator: '/',
    });
    expect(findRoot('/data/media/x/y.mp4', ['/data', '/data/media/'])).toBe(
      '/data/media',
    );
    expect(findRoot('/other/y.mp4', ['/data'])).toBeNull();
    expect(joinPath('/', '/data/', 'Studio', 'file.mp4')).toBe(
      '/data/Studio/file.mp4',
    );
  });
});

describe('whisparrFolderFor', () => {
  it('builds studio/date - title under the destination, without repeating scenes/', () => {
    const movie = {
      title: 'The: Scene',
      studio: 'Studio A',
      date: '2020-01-02',
      stashId: 'x',
    };
    expect(
      whisparrFolderFor(
        'scenes/{studio}/{date} - {title}',
        '/data/stash content',
        movie,
      ),
    ).toBe('/data/stash content/scenes/Studio A/2020-01-02 - The - Scene');
    expect(
      whisparrFolderFor(
        'scenes/{studio}/{date} - {title}',
        '/data/stash content/scenes/scenes',
        movie,
      ),
    ).toBe('/data/stash content/scenes/Studio A/2020-01-02 - The - Scene');
    expect(
      whisparrFolderFor('scenes/{studio}/{title}', '/data/x', {
        ...movie,
        studio: null,
      }),
    ).toBeNull();
  });
});

describe('whisparrFolderFormat', () => {
  it('turns the pattern into Whisparr tokens', () => {
    expect(whisparrFolderFormat('scenes/{studio}/{date} - {title}')).toBe(
      'scenes/{Studio Title}/{Release Date} - {Scene Title}',
    );
  });
});

describe('rename name length', () => {
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

  it('keeps long Japanese titles under the 255-byte file name limit', () => {
    const rendered = renderPattern('{studio}/{title}', {
      studio: 'スタジオ'.repeat(60),
      title: 'あ'.repeat(200),
    })!;
    expect(bytes(`${rendered.name}.mp4 (12)`)).toBeLessThanOrEqual(255);
    expect(bytes(rendered.folders[0])).toBeLessThanOrEqual(255);
  });

  it('never cuts an emoji in half', () => {
    const rendered = renderPattern('{title}', {
      title: `${'a'.repeat(179)}😀 tail`,
    })!;
    expect(rendered.name).toBe('a'.repeat(179));
    expect(rendered.name).not.toMatch(/[\ud800-\udfff]/);
  });

  it('tidies the end after cutting, so no name ends in a dot or dash', () => {
    const dot = renderPattern('{title}', {
      title: `${'a'.repeat(178)} . more words`,
    })!;
    expect(dot.name).toBe('a'.repeat(178));
    const dash = renderPattern('{title}', {
      title: `${'a'.repeat(178)} - more words`,
    })!;
    expect(dash.name).toBe('a'.repeat(178));
  });
});

describe('rename plans', () => {
  function sceneAt(path: string, title: string) {
    return {
      id: '1',
      title,
      code: null,
      date: '2020-01-02',
      organized: false,
      screenshotVersion: null,
      studio: { id: 's', name: 'Studio' },
      performers: [],
      tagIds: [],
      stashIds: [],
      files: [
        {
          id: 'f',
          path,
          basename: path.split('/').pop()!,
          duration: null,
          size: null,
          width: null,
          height: null,
          fingerprints: [],
        },
      ],
    };
  }
  const pattern = '{studio}/{date} - {title}';

  it('keeps the file’s own extension case', () => {
    const plan = planRename(
      sceneAt('/data/Studio/2020-01-02 - Title.MP4', 'Title'),
      ['/data'],
      pattern,
      new Set(),
    );
    expect(plan.state).toBe('same');
  });

  it('leaves a file whose name differs only in letter case', () => {
    const plan = planRename(
      sceneAt(
        '/data/studio/2020-01-02 - summer afternoon.mp4',
        'Summer Afternoon',
      ),
      ['/data'],
      pattern,
      new Set(),
    );
    expect(plan.state).toBe('same');
  });

  it('leaves a file whose accents are only encoded differently', () => {
    const decomposed = 'Café'.normalize('NFD');
    const plan = planRename(
      sceneAt(
        `/data/Studio/2020-01-02 - ${decomposed}.mp4`,
        'Café'.normalize('NFC'),
      ),
      ['/data'],
      pattern,
      new Set(),
    );
    expect(plan.state).toBe('same');
  });

  it('still renames a real change', () => {
    const plan = planRename(
      sceneAt('/data/inbox/x.mp4', 'Title'),
      ['/data'],
      pattern,
      new Set(),
    );
    expect(plan).toMatchObject({
      state: 'ready',
      to: '/data/Studio/2020-01-02 - Title.mp4',
    });
  });
});

describe('two scenes that want the same name', () => {
  const plan = (
    sceneId: string,
    from: string,
    to: string,
    state: 'ready' | 'same',
  ) => ({
    sceneId,
    fileId: `f${sceneId}`,
    title: 'Title',
    from,
    to,
    state,
  });

  it('gives the second one "(2)" the first time', () => {
    const plans = dedupeTargets([
      plan('1', '/data/in/a.mp4', '/data/S/Title.mp4', 'ready'),
      plan('2', '/data/in/b.mp4', '/data/S/Title.mp4', 'ready'),
    ]);
    expect(plans.map((entry) => [entry.to, entry.state])).toEqual([
      ['/data/S/Title.mp4', 'ready'],
      ['/data/S/Title (2).mp4', 'ready'],
    ]);
  });

  it('leaves both alone once they are renamed, instead of listing the "(2)" forever', () => {
    const plans = dedupeTargets([
      plan('1', '/data/S/Title.mp4', '/data/S/Title.mp4', 'same'),
      plan('2', '/data/S/Title (2).mp4', '/data/S/Title.mp4', 'ready'),
    ]);
    expect(plans[1]).toMatchObject({
      to: '/data/S/Title (2).mp4',
      state: 'same',
    });
  });
});

describe('inSceneFolder', () => {
  it('gives the scene a folder named like its file, as Whisparr does', () => {
    expect(
      inSceneFolder(
        '/data/fansdb/Studio/2024-01-02 - Title.mp4',
        '{studio}/{date} - {title}',
      ),
    ).toBe('/data/fansdb/Studio/2024-01-02 - Title/2024-01-02 - Title.mp4');
    expect(inSceneFolder('/data/fansdb/Title.mp4', '{title}')).toBe(
      '/data/fansdb/Title/Title.mp4',
    );
  });

  it('keeps a pattern whose last folder already names the scene', () => {
    expect(
      inSceneFolder(
        '/data/Studio/Title/Title - 1080p.mp4',
        '{studio}/{title}/{title} - {quality}',
      ),
    ).toBe('/data/Studio/Title/Title - 1080p.mp4');
    expect(
      inSceneFolder(
        '/data/Studio/2024-01-02 - Title/Title.mp4',
        '{Studio Title}/{Release Date} - {Scene Title}/{Scene Title}',
      ),
    ).toBe('/data/Studio/2024-01-02 - Title/Title.mp4');
  });

  it('doesn’t count a studio-only folder as the scene’s own', () => {
    expect(
      inSceneFolder('/data/Studio/Title.mp4', '{Studio Title}/{Scene Title}'),
    ).toBe('/data/Studio/Title/Title.mp4');
  });

  it('knows what is strictly below a folder', () => {
    expect(isUnderFolder('/data/dl/a/b.mp4', '/data/dl')).toBe(true);
    expect(isUnderFolder('/data/dl', '/data/dl')).toBe(false);
    expect(isUnderFolder('/data/dl/../x/b.mp4', '/data/dl')).toBe(false);
    expect(isUnderFolder('/data/dlx/b.mp4', '/data/dl')).toBe(false);
  });
});
