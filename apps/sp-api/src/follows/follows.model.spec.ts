import {
  type CandidateScene,
  clampSince,
  describeCheck,
  pickNewScenes,
} from './follows.model';

const NOW = new Date('2026-11-11T12:00:00Z');

function scene(
  id: string,
  releaseDate: string | null,
  state: CandidateScene['status']['state'] = 'NOT_REQUESTED',
): CandidateScene {
  return {
    id,
    title: `Scene ${id}`,
    cardImageUrl: null,
    imageUrl: null,
    studioId: null,
    studio: null,
    releaseDate,
    duration: null,
    status: { state },
  };
}

describe('clampSince', () => {
  it('is today when not given or not a day', () => {
    expect(clampSince(undefined, NOW)).toBe('2026-11-11');
    expect(clampSince('soon', NOW)).toBe('2026-11-11');
    expect(clampSince('2026-13-45', NOW)).toBe('2026-11-11');
  });

  it('keeps a day within the last year', () => {
    expect(clampSince('2026-10-01', NOW)).toBe('2026-10-01');
  });

  it('reaches back at most a year, and never ahead', () => {
    expect(clampSince('2020-01-01', NOW)).toBe('2025-11-11');
    expect(clampSince('2027-01-01', NOW)).toBe('2026-11-11');
  });
});

describe('pickNewScenes', () => {
  it('takes scenes released since the day, including upcoming ones', () => {
    const { fresh, reachedSince } = pickNewScenes(
      [
        scene('future', '2026-12-01'),
        scene('today', '2026-11-11'),
        scene('old', '2026-11-01'),
      ],
      '2026-11-10',
      new Set(),
    );
    expect(fresh.map((s) => s.id)).toEqual(['future', 'today']);
    expect(reachedSince).toBe(true);
  });

  it('leaves out scenes seen before, undated, requested or owned', () => {
    const { fresh, reachedSince } = pickNewScenes(
      [
        scene('seen', '2026-11-11'),
        scene('undated', null),
        scene('requested', '2026-11-11', 'REQUESTED'),
        scene('owned', '2026-11-11', 'AVAILABLE'),
        scene('new', '2026-11-11'),
      ],
      '2026-11-01',
      new Set(['seen']),
    );
    expect(fresh.map((s) => s.id)).toEqual(['new']);
    expect(reachedSince).toBe(false);
  });

  it('reads a timestamp as its day', () => {
    const { fresh } = pickNewScenes(
      [scene('a', '2026-11-05T00:00:00Z')],
      '2026-11-05',
      new Set(),
    );
    expect(fresh).toHaveLength(1);
  });
});

describe('describeCheck', () => {
  const base = { checked: 2, found: 0, requested: 0, failed: 0, errors: 0 };

  it('says when nobody is followed', () => {
    expect(describeCheck({ ...base, checked: 0 })).toBe(
      'Not following anyone yet.',
    );
  });

  it('says what was found and requested', () => {
    expect(describeCheck(base)).toBe('No new scenes.');
    expect(describeCheck({ ...base, found: 3, requested: 2, failed: 1 })).toBe(
      'Found 3 new scenes; added 2 to Wanted; 1 couldn’t be added.',
    );
    expect(describeCheck({ ...base, found: 1, errors: 1 })).toBe(
      'Found 1 new scene; 1 follow couldn’t be checked.',
    );
  });
});
