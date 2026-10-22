import { matchRelease, ReleaseMatchScene } from './release-match.util';

describe('matchRelease', () => {
  const scene: ReleaseMatchScene = {
    title: 'Sunset Rendezvous by the Pool',
    studio: 'Brazzers Exxtra',
    releaseDate: '2024-03-15',
    performers: ['Jane Doe', 'Ann Smith'],
  };

  it('is strong when the studio and date match', () => {
    expect(
      matchRelease('BrazzersExxtra.24.03.15.Some.Other.Words.XXX.1080p', scene),
    ).toEqual({ strength: 'strong', matched: ['studio', 'date'] });
  });

  it('is strong for a performer and the title, without the studio', () => {
    expect(
      matchRelease('Jane Doe - Sunset Rendezvous by the Pool [2160p]', scene),
    ).toEqual({ strength: 'strong', matched: ['performer', 'title'] });
  });

  it('reads full-year and day-first dates', () => {
    expect(
      matchRelease('Brazzers Exxtra 2024-03-15 1080p', scene)?.strength,
    ).toBe('strong');
    expect(
      matchRelease('Brazzers Exxtra 15.03.2024 1080p', scene)?.strength,
    ).toBe('strong');
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
});
