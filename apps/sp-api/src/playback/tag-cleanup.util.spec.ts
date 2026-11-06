import { nameKey, groupSimilarTags, tagKey } from './tag-cleanup.util';

const tag = (
  id: string,
  name: string,
  sceneCount: number,
  aliases: string[] = [],
) => ({
  id,
  name,
  aliases,
  sceneCount,
});

describe('tag cleanup', () => {
  it('reads past case, spacing, punctuation and a plural ending', () => {
    expect(tagKey('Big Tits')).toBe(tagKey('big-tits'));
    expect(tagKey('Blondes')).toBe(tagKey('blonde'));
    expect(tagKey('Pussies')).toBe('pussy');
    expect(tagKey('Kiss')).toBe('kiss');
    expect(tagKey('Glasses')).toBe('glass');
    expect(tagKey('Blonde')).not.toBe(tagKey('Blonde Hair'));
  });

  it('groups the same tag written differently, or listed as an alias, keeping the most used', () => {
    const groups = groupSimilarTags([
      tag('1', 'Blonde', 40),
      tag('2', 'blondes', 300),
      tag('3', 'Blonde Hair', 10),
      tag('4', 'Cowgirl', 20, ['Riding']),
      tag('5', 'riding', 3),
      tag('6', 'Anal', 90),
    ]);
    expect(groups).toEqual([
      { keepId: '2', tags: [tag('2', 'blondes', 300), tag('1', 'Blonde', 40)] },
      {
        keepId: '4',
        tags: [tag('4', 'Cowgirl', 20, ['Riding']), tag('5', 'riding', 3)],
      },
    ]);
  });
});

describe('nameKey', () => {
  it('ignores case, Latin accents, spacing and punctuation, and keeps other scripts', () => {
    expect(nameKey('Jané  Doe')).toBe(nameKey('jane-doe'));
    expect(nameKey('Rock & Roll')).toBe('rockandroll');
    expect(nameKey('Анна')).toBe('анна');
    expect(nameKey('愛 さん')).toBe('愛さん');
    expect(nameKey('が')).not.toBe(nameKey('か'));
    expect(nameKey('김')).not.toBe('');
    // Only Latin letters lose their marks: й isn't и.
    expect(nameKey('й')).not.toBe(nameKey('и'));
    expect(nameKey('Ёлка')).not.toBe(nameKey('Елка'));
    expect(nameKey('Zoë')).toBe(nameKey('Zoe'));
  });
});
