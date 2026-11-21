import {
  type WatchedScene,
  buildTasteProfile,
  diversify,
  findCostars,
  pickSources,
  rankCandidates,
  reshuffle,
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

  it('asks the ones you watch most every time, and draws a few more by weight', () => {
    const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) => ({
      catalogId: name,
      name,
      weight: 10 - index,
    }));
    const rolls = [0.99, 0];
    const picked = pickSources(entries, 2, 2, 3, () => rolls.shift() ?? 0);

    expect(picked.map((entry) => entry.catalogId)).toEqual([
      'a',
      'b',
      'e',
      'c',
    ]);
    expect(
      pickSources(entries.slice(0, 2), 2, 2, 3).map((entry) => entry.catalogId),
    ).toEqual(['a', 'b']);
  });

  it('reshuffles with a nudge, pushing what was just shown down', () => {
    const ranked = ['a', 'b', 'c'].map((id, index) => ({
      scene: { id, studioId: null, releaseDate: null },
      score: 3 - index,
      reason: { key: 'performer:x', text: 'x' },
    }));
    const order = reshuffle(ranked, new Set(['a']), () => 0.5).map(
      (entry) => entry.scene.id,
    );
    expect(order).toEqual(['b', 'c', 'a']);
  });
});

describe('categories you watch', () => {
  const scenes = (tags: string[][]): WatchedScene[] =>
    tags.map((names) => ({
      playCount: 2,
      oCounter: 0,
      rating100: null,
      lastPlayedAt: null,
      performers: [],
      studio: null,
      tags: names,
    }));

  it('weighs telling categories above ones on nearly everything, and drops one-offs', () => {
    const profile = buildTasteProfile(
      scenes([
        ['HD', 'Anal'],
        ['HD', 'Anal'],
        ['HD'],
        ['HD'],
        ['HD'],
        ['HD', 'Once'],
      ]),
      NOW,
    );
    const names = (profile.tags ?? []).map((entry) => entry.name);
    // On two of six scenes says more about you than one on all six.
    expect(names[0]).toBe('Anal');
    expect(names).toContain('HD');
    // Seen once: not a taste yet.
    expect(names).not.toContain('Once');
  });

  it('ranks a catalog scene by the categories it shares with you, saying which', () => {
    const profile = buildTasteProfile(
      scenes([['Anal', 'Outdoors'], ['Anal', 'Outdoors'], ['Anal']]),
      NOW,
    );
    const ranked = rankCandidates(
      [
        {
          id: 'plain',
          studioId: null,
          releaseDate: null,
          tagNames: ['Kissing'],
        },
        {
          id: 'both',
          studioId: null,
          releaseDate: null,
          tagNames: ['outdoors', 'Anal'],
        },
        { id: 'one', studioId: null, releaseDate: null, tagNames: ['Anal'] },
      ],
      profile,
      new Map(),
      NOW,
    );
    expect(ranked.map((entry) => entry.scene.id)).toEqual(['both', 'one']);
    // Outdoors is on fewer of the scenes you watch, so it says more.
    expect(ranked[0].reason).toEqual({
      key: 'tag:outdoors',
      text: 'Outdoors and Anal, which you watch a lot',
    });
  });
});

describe('findCostars', () => {
  const profile = {
    performers: [
      { catalogId: 'k', name: 'Kaitlyn', weight: 10 },
      { catalogId: 'm', name: 'Mia', weight: 4 },
    ],
    studios: [],
  };
  const scene = (id: string, people: string[]) => ({
    id,
    studioId: null,
    releaseDate: null,
    performers: people.map((person) => ({
      id: person,
      name: person.toUpperCase(),
    })),
  });

  it('finds people who keep turning up with those you watch, not those you already do', () => {
    const costars = findCostars(
      [
        scene('1', ['k', 'nova']),
        scene('2', ['k', 'nova', 'm']),
        scene('3', ['m', 'zed']),
        scene('4', ['m', 'zed']),
        scene('5', ['k', 'once']),
        // The same scene twice (from two of your performers) counts once.
        scene('2', ['k', 'nova', 'm']),
      ],
      profile,
      5,
    );
    expect(costars).toEqual([
      { catalogId: 'nova', name: 'NOVA', partner: 'Kaitlyn', weight: 20 },
      { catalogId: 'zed', name: 'ZED', partner: 'Mia', weight: 8 },
    ]);
  });
});

describe('diversify', () => {
  const entry = (id: string, key: string, studioId: string | null = null) => ({
    scene: { id, studioId, releaseDate: null },
    score: 1,
    reason: { key, text: key },
  });

  it('keeps one reason or studio from taking a whole screenful', () => {
    const order = diversify(
      [
        entry('1', 'studio:x', 'x'),
        entry('2', 'studio:x', 'x'),
        entry('3', 'studio:x', 'x'),
        entry('4', 'studio:x', 'x'),
        entry('5', 'performer:k'),
        entry('6', 'tag:anal', 'y'),
      ],
      6,
      2,
    ).map((item) => item.scene.id);
    expect(order.slice(0, 4)).toEqual(['1', '2', '5', '6']);
    // Nothing is dropped: the rest follow.
    expect(order).toHaveLength(6);
  });
});
