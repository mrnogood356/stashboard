import {
  type WatchedScene,
  buildTasteProfile,
  rankCandidates,
} from './suggestions.util';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const daysAgo = (days: number) =>
  new Date(NOW - days * 86_400_000).toISOString();
const watched = (over: Partial<WatchedScene>): WatchedScene => ({
  playCount: 1,
  oCounter: 0,
  rating100: null,
  lastPlayedAt: daysAgo(1),
  performers: [],
  studio: null,
  ...over,
});
const kaitlyn = { catalogId: 'p-k', name: 'Kaitlyn', favorite: false };
const alex = { catalogId: 'p-a', name: 'Alex', favorite: false };
const unlinked = { catalogId: null, name: 'Nobody', favorite: false };
const raw = { catalogId: 's-raw', name: 'Blacked Raw', favorite: false };

describe('You may enjoy', () => {
  it('weighs plays, O and ratings, recent ones more, and only catalog-linked people', () => {
    const profile = buildTasteProfile(
      [
        watched({
          playCount: 5,
          oCounter: 2,
          rating100: 100,
          performers: [kaitlyn, unlinked],
          studio: raw,
        }),
        // Watched as often, but a year ago.
        watched({
          playCount: 5,
          oCounter: 2,
          rating100: 100,
          lastPlayedAt: daysAgo(365),
          performers: [alex],
        }),
        // Nothing to go by.
        watched({ playCount: 0, performers: [alex] }),
      ],
      NOW,
    );
    expect(profile.performers.map((entry) => entry.name)).toEqual([
      'Kaitlyn',
      'Alex',
    ]);
    expect(profile.performers[0].weight).toBeGreaterThan(
      profile.performers[1].weight * 3,
    );
    expect(profile.studios).toEqual([
      expect.objectContaining({ catalogId: 's-raw' }),
    ]);
  });

  it('ranks by who you watch, once each, with the reason that counted most', () => {
    const profile = buildTasteProfile(
      [
        watched({ playCount: 10, performers: [kaitlyn], studio: raw }),
        watched({ playCount: 2, performers: [alex] }),
      ],
      NOW,
    );
    const ranked = rankCandidates(
      [
        {
          id: 'c1',
          studioId: null,
          releaseDate: '2020-01-01',
          performers: [{ id: 'p-a', name: 'Alex' }],
        },
        {
          id: 'c2',
          studioId: 's-raw',
          releaseDate: '2020-01-01',
          performers: [{ id: 'p-k', name: 'Kaitlyn' }],
        },
        { id: 'c2', studioId: 's-raw', releaseDate: '2020-01-01' },
        { id: 'c3', studioId: 'other', releaseDate: '2020-01-01' },
      ],
      profile,
      new Map(),
      NOW,
    );
    expect(ranked.map((entry) => entry.scene.id)).toEqual(['c2', 'c1']);
    expect(ranked[0].reason).toEqual({
      key: 'performer:p-k',
      text: 'Because you watch Kaitlyn',
    });
  });

  it('counts a reason less after each Not interested', () => {
    const profile = buildTasteProfile(
      [
        watched({ playCount: 3, performers: [kaitlyn] }),
        watched({ playCount: 2, performers: [alex] }),
      ],
      NOW,
    );
    const candidates = [
      {
        id: 'k',
        studioId: null,
        releaseDate: null,
        performers: [{ id: 'p-k', name: 'Kaitlyn' }],
      },
      {
        id: 'a',
        studioId: null,
        releaseDate: null,
        performers: [{ id: 'p-a', name: 'Alex' }],
      },
    ];
    expect(
      rankCandidates(candidates, profile, new Map(), NOW)[0].scene.id,
    ).toBe('k');
    expect(
      rankCandidates(
        candidates,
        profile,
        new Map([['performer:p-k', 3]]),
        NOW,
      )[0].scene.id,
    ).toBe('a');
  });
});
