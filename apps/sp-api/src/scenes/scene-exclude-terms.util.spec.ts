import {
  EMPTY_EXCLUDE_RULES,
  applyExcludeRules,
  buildExcludeMatchers,
  exceptRequested,
  hasExcludeRules,
  needsSceneTags,
  isSceneExcluded,
  matchesAnyExcludeTerm,
  parseExcludeTerms,
  splitNegatedTerms,
} from './scene-exclude-terms.util';

describe('scene exclude terms', () => {
  it('splits on commas and spaces, drops leading dashes and duplicates', () => {
    expect(parseExcludeTerms(['Trans, transgender', ' -trans  pov'])).toEqual([
      'trans',
      'transgender',
      'pov',
    ]);
  });

  it('pulls "-word" tokens out of a text search', () => {
    expect(splitNegatedTerms('  anal  -trans -Transgender pov - ')).toEqual({
      text: 'anal pov -',
      excluded: ['trans', 'transgender'],
    });
    expect(splitNegatedTerms(undefined)).toEqual({ text: '', excluded: [] });
  });

  it('matches whole words case-insensitively', () => {
    const matchers = buildExcludeMatchers(['trans', 'c++']);

    expect(matchesAnyExcludeTerm(['A TRANS scene'], matchers)).toBe(true);
    expect(matchesAnyExcludeTerm(['trans-woman'], matchers)).toBe(true);
    expect(matchesAnyExcludeTerm(['Transfer'], matchers)).toBe(false);
    expect(matchesAnyExcludeTerm(['learning c++ now'], matchers)).toBe(true);
    expect(matchesAnyExcludeTerm([null, undefined, ''], matchers)).toBe(false);
    expect(matchesAnyExcludeTerm(['trans'], [])).toBe(false);
  });

  it('caps how many terms are kept, 25 unless told otherwise', () => {
    const many = Array.from({ length: 40 }, (_, index) => `w${index}`);

    expect(parseExcludeTerms(many)).toHaveLength(25);
    expect(parseExcludeTerms(many, 100)).toHaveLength(40);
  });

  describe('rules', () => {
    const scene = {
      title: 'Night',
      details: null,
      studioId: 'studio-1',
      studioName: 'Studio',
      tagIds: ['tag-1'],
      tagNames: ['Trans Woman'],
    };

    it('matches by word in tags, by tag id and by studio id', () => {
      expect(
        isSceneExcluded(scene, {
          ...EMPTY_EXCLUDE_RULES,
          matchers: buildExcludeMatchers(['trans']),
        }),
      ).toBe(true);
      expect(
        isSceneExcluded(scene, {
          ...EMPTY_EXCLUDE_RULES,
          tagIds: new Set(['tag-1']),
        }),
      ).toBe(true);
      expect(
        isSceneExcluded(scene, {
          ...EMPTY_EXCLUDE_RULES,
          studioIds: new Set(['studio-1']),
        }),
      ).toBe(true);
      expect(
        isSceneExcluded(
          { ...scene, tagIds: undefined, tagNames: undefined },
          { ...EMPTY_EXCLUDE_RULES, tagIds: new Set(['tag-1']) },
        ),
      ).toBe(false);
      expect(isSceneExcluded(scene, EMPTY_EXCLUDE_RULES)).toBe(false);
    });

    it('knows when there is nothing to apply', () => {
      expect(hasExcludeRules(EMPTY_EXCLUDE_RULES)).toBe(false);
      expect(
        hasExcludeRules({
          ...EMPTY_EXCLUDE_RULES,
          studioIds: new Set(['studio-1']),
        }),
      ).toBe(true);
    });

    it('counts only what the hidden rules take out', () => {
      const scenes = [
        { ...scene, id: 'a', tagNames: [], tagIds: [] },
        { ...scene, id: 'b', title: 'Anal' },
        { ...scene, id: 'c' },
      ];

      const result = applyExcludeRules(
        scenes,
        { ...EMPTY_EXCLUDE_RULES, matchers: buildExcludeMatchers(['anal']) },
        { ...EMPTY_EXCLUDE_RULES, tagIds: new Set(['tag-1']) },
      );

      expect(result.scenes.map((entry) => entry.id)).toEqual(['a']);
      expect(result.hidden).toBe(1);
    });

    it('hides a scene with a hidden performer, matched by id only', () => {
      const rules = { ...EMPTY_EXCLUDE_RULES, performerIds: new Set(['p-1']) };

      expect(
        isSceneExcluded(
          { ...scene, performers: [{ id: 'p-1', name: 'Jane' }] },
          rules,
        ),
      ).toBe(true);
      expect(
        isSceneExcluded(
          { ...scene, performers: [{ id: 'p-2', name: 'Jane' }] },
          rules,
        ),
      ).toBe(false);
    });

    it('matches tags and studios by name, for a list saved in another catalog', () => {
      expect(
        isSceneExcluded(
          { ...scene, tagIds: ['fansdb-tag'], tagNames: ['Trans Woman'] },
          { ...EMPTY_EXCLUDE_RULES, tagNames: new Set(['trans woman']) },
        ),
      ).toBe(true);
      expect(
        isSceneExcluded(
          { ...scene, studioId: 'other-id', studioName: 'Some Studio' },
          { ...EMPTY_EXCLUDE_RULES, studioNames: new Set(['some studio']) },
        ),
      ).toBe(true);
    });

    it('only needs tags fetched for words, tags or performers', () => {
      expect(
        needsSceneTags({
          ...EMPTY_EXCLUDE_RULES,
          studioIds: new Set(['s']),
          studioNames: new Set(['s']),
        }),
      ).toBe(false);
      expect(
        needsSceneTags({
          ...EMPTY_EXCLUDE_RULES,
          performerIds: new Set(['p']),
        }),
      ).toBe(true);
      expect(
        needsSceneTags({ ...EMPTY_EXCLUDE_RULES, tagNames: new Set(['t']) }),
      ).toBe(true);
    });

    it('lets a list show the studio, tag or performer it was asked for', () => {
      const rules = {
        ...EMPTY_EXCLUDE_RULES,
        studioIds: new Set(['s-1', 's-2']),
        tagIds: new Set(['t-1']),
        performerIds: new Set(['p-1']),
      };

      const relaxed = exceptRequested(rules, {
        studioIds: ['s-1'],
        tagIds: ['t-1'],
        performerIds: ['p-1'],
      });

      expect([...relaxed.studioIds]).toEqual(['s-2']);
      expect(relaxed.tagIds.size).toBe(0);
      expect(relaxed.performerIds.size).toBe(0);
      expect(exceptRequested(rules, { studioIds: ['other'] })).toBe(rules);
    });
  });
});
