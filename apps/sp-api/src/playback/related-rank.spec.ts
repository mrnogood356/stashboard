import type { StashLocalSceneCard } from '../providers/stash/stash.adapter';
import { rankRelated } from './local-library.service';

const card = (id: string, playCount = 0) =>
  ({
    id,
    title: id,
    date: null,
    screenshotVersion: null,
    studio: null,
    duration: null,
    playCount,
    resumeTime: 0,
  }) as StashLocalSceneCard;

describe('rankRelated', () => {
  it('puts scenes with the most in common first, unplayed before played', () => {
    const ranked = rankRelated('self', [
      { items: [card('self'), card('a'), card('b', 2)], weight: 3 },
      { items: [card('c'), card('b', 2)], weight: 2 },
      { items: [card('a'), card('d'), card('e', 1)], weight: 1 },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(['b', 'a', 'c', 'd', 'e']);
  });
});
