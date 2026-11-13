import { matchRelease, ReleaseMatchScene } from './release-match.util';

describe('matchRelease', () => {
  const scene: ReleaseMatchScene = {
    title: 'Sunset Rendezvous by the Pool',
    studio: 'Brazzers Exxtra',
    releaseDate: '2024-03-15',
    performers: ['Jane Doe', 'Ann Smith'],
  };

  it('is only partial when just the studio and date match: another scene from that day fits too', () => {
    expect(
      matchRelease('BrazzersExxtra.24.03.15.Some.Other.Words.XXX.1080p', scene),
    ).toEqual({ strength: 'partial', matched: ['studio', 'date'] });
    // The same studio and day, a different performer: not this scene.
    expect(
      matchRelease('EvilAngel.25.03.19.Khloe.Kingsley.XXX.1080p.MP4-WRB', {
        title: 'Metal Ass Fuck',
        studio: 'Evil Angel',
        releaseDate: '2025-03-19',
        performers: ['Sabien DeMonia', 'Morea Black'],
      })?.strength,
    ).toBe('partial');
  });

  it('is strong when the studio and date match and a performer is named', () => {
    expect(
      matchRelease('EvilAngel.25.03.19.Sabien.DeMonia.XXX.1080p.MP4-WRB', {
        title: 'Metal Ass Fuck',
        studio: 'Evil Angel',
        releaseDate: '2025-03-19',
        performers: ['Sabien DeMonia', 'Morea Black'],
      }),
    ).toEqual({ strength: 'strong', matched: ['studio', 'date', 'performer'] });
  });

  it('is strong for a performer and the title, without the studio', () => {
    expect(
      matchRelease('Jane Doe - Sunset Rendezvous by the Pool [2160p]', scene),
    ).toEqual({ strength: 'strong', matched: ['performer', 'title'] });
  });

  it('reads full-year and day-first dates', () => {
    for (const release of [
      'Brazzers Exxtra 2024-03-15 Jane Doe 1080p',
      'Brazzers Exxtra 15.03.2024 Jane Doe 1080p',
    ]) {
      const match = matchRelease(release, scene);
      expect(match?.strength).toBe('strong');
      expect(match?.matched).toContain('date');
    }
  });

  it('doesn’t count the studio’s name as the title', () => {
    expect(
      matchRelease('Evil.Angel.25.03.19.Khloe.Kingsley.XXX.1080p', {
        title: 'Angel',
        studio: 'Evil Angel',
        releaseDate: '2025-03-19',
        performers: ['Sabien DeMonia'],
      }),
    ).toEqual({ strength: 'partial', matched: ['studio', 'date'] });
  });

  it('is partial with only one thing in common besides the studio', () => {
    expect(matchRelease('Ann.Smith.Compilation.XXX.720p', scene)).toEqual({
      strength: 'partial',
      matched: ['performer'],
    });
  });

  it('is weak with only the studio, or nothing, in common', () => {
    expect(
      matchRelease('BrazzersExxtra.Best.Of.2023.XXX.1080p', scene)?.strength,
    ).toBe('weak');
    expect(matchRelease('Random.Movie.2019.1080p.WEB', scene)).toEqual({
      strength: 'weak',
      matched: [],
    });
  });

  it('is weak when the name has another date, even from the same studio', () => {
    expect(
      matchRelease('BrazzersExxtra.24.05.02.Jane.Doe.XXX.1080p', scene),
    ).toEqual({ strength: 'weak', matched: ['studio', 'performer'] });
  });

  it('does not match a performer on a first name alone', () => {
    expect(matchRelease('Jane.Rides.Again.XXX', scene)?.matched).not.toContain(
      'performer',
    );
  });

  it('cannot say when nothing is known about the scene', () => {
    expect(
      matchRelease('Anything.XXX', {
        title: null,
        studio: null,
        releaseDate: null,
        performers: [],
      }),
    ).toBeNull();
  });

  it('calls another studio’s scene with the same performer on the same day weak', () => {
    const scene = {
      title: 'Maddie Wren’s Red-Lingerie Anal Escapade',
      studio: 'Bang! Surprise',
      releaseDate: '2026-10-21',
      performers: ['Maddie Wren'],
    };
    expect(
      matchRelease('TrueAnal.26.10.21.Maddie.Wren.XXX.1080p.MP4-NBQ', scene)
        ?.strength,
    ).toBe('weak');
    expect(
      matchRelease(
        'Bang.Surprise.26.10.21.Maddie.Wren.XXX.1080p.MP4-WRB',
        scene,
      )?.strength,
    ).toBe('strong');
    // Written together, or shortened, it's still the studio.
    expect(
      matchRelease('BangSurprise.26.10.21.Maddie.Wren.XXX.1080p', scene)
        ?.strength,
    ).toBe('strong');
    // No studio in front of the date: nothing to go on either way.
    expect(
      matchRelease(
        'Maddie.Wren.Red.Lingerie.Anal.Escapade.26.10.21.1080p',
        scene,
      )?.strength,
    ).toBe('strong');
  });
});
