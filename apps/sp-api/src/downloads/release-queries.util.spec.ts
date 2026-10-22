import { buildReleaseQueries, shortDate } from './release-queries.util';

describe('buildReleaseQueries', () => {
  it('tries studio + date, studio + title, performer + title and performer + date', () => {
    expect(
      buildReleaseQueries({
        title: 'Beach Day: Part 2!',
        studio: 'Sunny Studio',
        releaseDate: '2024-03-15',
        performers: ['Jane Doe', 'John Roe'],
      }),
    ).toEqual([
      'Sunny Studio 24.03.15',
      'Sunny Studio Beach Day Part 2',
      'Jane Doe Beach Day Part 2',
      'Jane Doe 24.03.15',
    ]);
  });

  it('drops a repeat when the creator is both studio and performer', () => {
    expect(
      buildReleaseQueries({
        title: 'Beach Day',
        studio: 'Jane Doe (OnlyFans)',
        releaseDate: null,
        performers: ['Jane Doe'],
      }),
    ).toEqual(['Jane Doe Beach Day']);
  });

  it('keeps long titles to their first words', () => {
    expect(
      buildReleaseQueries({
        title: 'One two three four five six seven eight',
        studio: 'Studio',
        releaseDate: null,
        performers: [],
      }),
    ).toEqual(['Studio One two three four five six']);
  });

  it('falls back to the title alone, or nothing', () => {
    expect(
      buildReleaseQueries({
        title: 'Beach Day',
        studio: null,
        releaseDate: '2024-03-15',
        performers: [],
      }),
    ).toEqual(['Beach Day']);
    expect(
      buildReleaseQueries({
        title: null,
        studio: null,
        releaseDate: null,
        performers: [],
      }),
    ).toEqual([]);
  });

  it('writes the date the way release names do', () => {
    expect(shortDate('2024-03-15')).toBe('24.03.15');
    expect(shortDate('2024')).toBe('');
    expect(shortDate(null)).toBe('');
  });
});
