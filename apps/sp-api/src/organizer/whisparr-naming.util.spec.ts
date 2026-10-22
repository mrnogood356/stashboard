import {
  renderWhisparrFolders,
  renderWhisparrPattern,
  whisparrQuality,
  type WhisparrSceneValues,
} from './whisparr-naming.util';

// Expected names come from Whisparr's own tests
// (src/NzbDrone.Core.Test/OrganizerTests/FileNameBuilderTests), with the
// movie tokens there swapped for the scene ones.
const scene: WhisparrSceneValues = {
  title: 'The Last Train Home',
  studio: 'Pure Taboo',
  date: '2025-11-25',
  stashId: '019abb52-0557-7c5f-83df-94b828851fd1',
  performers: [
    { name: 'Rissa May', gender: 'FEMALE' },
    { name: "Maddy O'Reilly", gender: 'FEMALE' },
    { name: 'Charles Dera', gender: 'MALE' },
    { name: 'Reagan Foxx', gender: 'FEMALE' },
    { name: 'Axel Haze', gender: 'MALE' },
    { name: 'Manuel Ferrara', gender: 'MALE' },
  ],
  quality: 'HDTV-720p',
  releaseGroup: 'WhisparrTest',
};

const name = (pattern: string, values: Partial<WhisparrSceneValues> = {}) =>
  renderWhisparrPattern(pattern, { ...scene, ...values })?.name;

describe('Whisparr naming', () => {
  it.each([
    [
      '{Studio Title} - {Release-Date} - {Scene Title}',
      'Pure Taboo - 2025-11-25 - The Last Train Home',
    ],
    [
      '{Studio Title} - {Release-Date} - {Scene Title} [{Scene Performers}]',
      "Pure Taboo - 2025-11-25 - The Last Train Home [Axel Haze Charles Dera Maddy O'Reilly Manuel Ferrara]",
    ],
    [
      '{Studio Title} - {Release-Date} - {Scene Title} [{Scene CleanPerformers}]',
      'Pure Taboo - 2025-11-25 - The Last Train Home [Axel Haze Charles Dera Maddy OReilly Manuel Ferrara]',
    ],
    [
      '{Studio Title} - {Release-Date} - {Scene Title} [{Scene PerformersFemale}]',
      "Pure Taboo - 2025-11-25 - The Last Train Home [Maddy O'Reilly Reagan Foxx Rissa May]",
    ],
    [
      '{Studio Title} - {Release-Date} - {Scene Title} [{Scene CleanPerformersFemale}]',
      'Pure Taboo - 2025-11-25 - The Last Train Home [Maddy OReilly Reagan Foxx Rissa May]',
    ],
    ['{Scene Title}', 'The Last Train Home'],
    ['{Scene_Title}', 'The_Last_Train_Home'],
    ['{Scene.Title}', 'The.Last.Train.Home'],
    ['{Scene-Title}', 'The-Last-Train-Home'],
    ['{SCENE TITLE}', 'THE LAST TRAIN HOME'],
    ['{sCeNe-tItLE}', 'The-Last-Train-Home'],
    ['{scene title}', 'the last train home'],
    ['{Quality Title}', 'HDTV-720p'],
    ['{Scene Title} [{Quality Title}]', 'The Last Train Home [HDTV-720p]'],
    [
      '{Scene Title} [{Quality Title}] {[Quality Proper]}',
      'The Last Train Home [HDTV-720p]',
    ],
    ['{Scene Title} [{Quality Full}]', 'The Last Train Home [HDTV-720p]'],
    ['{Scene.Title}.{_Quality.Title_}', 'The.Last.Train.Home._HDTV-720p'],
    [
      '{Quality.Title}.{Quality.Proper}.{Scene.Title}',
      'HDTV-720p.The.Last.Train.Home',
    ],
    ['{Release Group}', 'WhisparrTest'],
    ['{Scene Collection}', undefined],
  ])('%s', (pattern, expected) => {
    expect(name(pattern)).toBe(expected);
  });

  it('marks Proper and REAL like Whisparr', () => {
    expect(
      name('{Scene Title} [{Quality Full}]', { qualityProper: true }),
    ).toBe('The Last Train Home [HDTV-720p Proper]');
    expect(name('{Scene Title} [{Quality Full}]', { qualityReal: true })).toBe(
      'The Last Train Home [HDTV-720p REAL]',
    );
  });

  it('uses "Whisparr" for a missing release group only when it stands alone', () => {
    expect(name('{Release Group}', { releaseGroup: null })).toBe('Whisparr');
    for (const pattern of [
      '{Scene Title}{-Release Group}',
      '{Scene Title}{ Release Group}',
      '{Scene Title}{ [Release Group]}',
    ]) {
      expect(name(pattern, { releaseGroup: null })).toBe('The Last Train Home');
    }
  });

  it('drops the trailing dot and squashes repeated separators', () => {
    expect(name('{Scene.Title}', { title: 'Venture Bros.' })).toBe(
      'Venture.Bros',
    );
    expect(name('{Scene.CleanTitle}', { title: 'South Park (1997)' })).toBe(
      'South.Park.1997',
    );
  });

  it.each([
    ['Florence + the Machine', 'Florence + the Machine'],
    ['Beyoncé X10', 'Beyonce X10'],
    ["Girlfriends' Guide to Divorce", 'Girlfriends Guide to Divorce'],
    ['Rule #23: Never Lie to the Kids', 'Rule #23 Never Lie to the Kids'],
    [
      'Anne Hathaway/Florence + The Machine',
      'Anne Hathaway Florence + The Machine',
    ],
    ['Chris Rock/Prince', 'Chris Rock Prince'],
    ["Karma's a B*tch!", 'Karmas a B-tch!'],
    ['Ke$ha: My Crazy Beautiful Life', 'Ke$ha My Crazy Beautiful Life'],
    ['$#*! My Dad Says', '$#-! My Dad Says'],
    ['Free! - Iwatobi Swim Club', 'Free! Iwatobi Swim Club'],
    ['Tamara Ecclestone: Billion $$ Girl', 'Tamara Ecclestone Billion $$ Girl'],
    ["Marvel's Agents of S.H.I.E.L.D.", 'Marvels Agents of S.H.I.E.L.D'],
    ['Castle (2009)', 'Castle 2009'],
    ['Law & Order (UK)', 'Law and Order UK'],
    ['Is this okay?', 'Is this okay'],
    ['[a] title', 'a title'],
    ['backslash \\ backlash', 'backslash backlash'],
    ["I'm the Boss", 'Im the Boss'],
    ['Horny Host Can’t Help Herself', 'Horny Host Cant Help Herself'],
    ['You’re the Babe for the Job', 'Youre the Babe for the Job'],
    ["I've Been Caught", 'Ive Been Caught'],
    ["That'll Be The Day", 'Thatll Be The Day'],
    ["I'd Rather Be Alone", 'Id Rather Be Alone'],
    ["I Can't Die", 'I Cant Die'],
    ['Won`t Get Fooled Again', 'Wont Get Fooled Again'],
    ['Don’t Blink', 'Dont Blink'],
    ['The ` Legend of Kings', 'The Legend of Kings'],
    ['Joker: Folie à deux', 'Joker Folie a deux'],
  ])('cleans "%s" like Whisparr', (title, expected) => {
    expect(name('{Scene CleanTitle}', { title })).toBe(expected);
  });

  it.each([
    ['My Scene Title S01:E02', 'My Scene Title'],
    ['My Scene Title s01:e02', 'My Scene Title'],
    ['My Scene Title S1:E2', 'My Scene Title'],
  ])('leaves out the episode in "%s"', (title, expected) => {
    expect(name('{Scene CleanTitleNoSeasonEpisode}', { title })).toBe(expected);
  });

  it('builds the user’s Whisparr formats', () => {
    const rendered = renderWhisparrPattern(
      'scenes/{Studio Title}/{Release Date} - {Scene Title}/{Studio CleanTitleSlug}.{Scene.CleanTitle}.{Release Date}{.Quality.Title}{-Release Group}',
      {
        ...scene,
        studio: 'Mr. Anal',
        title: 'Who’s Next? Part 2: The Return',
        quality: 'WEBDL-1080p',
        releaseGroup: null,
      },
    );
    expect(rendered).toEqual({
      folders: [
        'scenes',
        'Mr. Anal',
        '2025-11-25 - Who’s Next! Part 2 - The Return',
      ],
      name: 'Mr.Anal.Whos.Next.Part.2.The.Return.2025-11-25.WEBDL-1080p',
    });
    expect(
      renderWhisparrFolders(
        'scenes/{Studio Title}/{Release Date} - {Scene Title}',
        {
          ...scene,
          date: null,
        },
      ),
    ).toEqual(['scenes', 'Pure Taboo', 'Unknown - The Last Train Home']);
  });

  it('keeps names within 255 characters by shortening the title, as Whisparr does', () => {
    const long = 'A very long scene title '.repeat(20);
    const result = name('{Studio Title} - {Scene Title} [{Quality Title}]', {
      title: long,
    });
    expect(result!.length).toBeLessThanOrEqual(255);
    expect(result).toMatch(/^Pure Taboo - A very long/);
    expect(result).toMatch(/\[HDTV-720p\]$/);
  });

  it.each([
    ['Studio.25.01.01.Title.XXX.1080p.MP4-WRB.mp4', null, 'WEBDL-1080p'],
    ['Studio.Title.2160p.WEB-DL.mkv', null, 'WEBDL-2160p'],
    ['Studio.Title.720p.WEBRip.mp4', null, 'WEBRip-720p'],
    ['Studio.Title.1080p.BluRay.mkv', null, 'Bluray-1080p'],
    ['some video.mp4', 1080, 'WEBDL-1080p'],
    ['some video.mp4', 1440, 'WEBDL-1080p'],
    ['some video.mp4', 540, 'WEBDL-480p'],
    ['some video.mp4', null, 'Unknown'],
  ])('reads the quality of %s like Whisparr', (file, height, expected) => {
    expect(whisparrQuality(file, height).title).toBe(expected);
  });
});
