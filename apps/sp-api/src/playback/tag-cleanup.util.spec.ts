import {
  cannotBeOne,
  nameKey,
  groupMergeCandidates,
  groupSimilarTags,
  tagKey,
} from './tag-cleanup.util';

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

describe('groupMergeCandidates', () => {
  const person = (
    id: string,
    name: string,
    sceneCount: number,
    aliases: string[] = [],
    links: string[] = [],
  ) => ({ id, name, aliases, sceneCount, note: null, links });
  const ids = (groups: ReturnType<typeof groupMergeCandidates>) =>
    groups.map((group) => group.items.map((item) => item.id));

  it('never pairs different people over a first name they both have as an alias', () => {
    // As Merge showed them: different people, linked only by shared aliases.
    const groups = groupMergeCandidates([
      person('1', 'Kristy Black', 5, [
        'Inke',
        'Jelly Baby',
        'Kristina',
        'Melissa',
      ]),
      person('2', 'Brandy Salazar', 1, ['Brandy Licious', 'Kristina', 'Molly']),
      person('3', 'Riley Reid', 1, ['Luiselle', 'Melissa', 'Molly']),
      person('4', 'Ria Sunn', 4, ['Cici', 'Isabell', 'Nikola', 'Julia']),
      person('5', 'Julia North', 1, ['Dafna May', 'Julia', 'Julia Smile']),
      person('6', 'Juelz Ventura', 3, ['Juelz', 'Riley']),
      person('7', 'Riley Ray', 1, ['Ashlyn Aka Riley Ray', 'Ray Ray', 'Riley']),
    ]);
    expect(groups).toEqual([]);
  });

  it('pairs the same name, a full name listed as an alias, and the same StashDB entry', () => {
    const groups = groupMergeCandidates([
      person('1', 'Jane Doe', 9),
      person('2', 'jane  doe', 2),
      person('3', 'JD', 1, ['Jane Doe']),
      person('4', 'Mia', 4, [], ['https://stashdb.org/graphql|m1']),
      person('5', 'Mia Ray', 1, [], ['https://stashdb.org/graphql|m1']),
      // A one-word alias isn't enough on its own.
      person('6', 'Jane', 3),
      person('7', 'Janey Smith', 1, ['Jane']),
    ]);
    expect(ids(groups)).toEqual([
      ['1', '2', '3'],
      ['4', '5'],
    ]);
    expect(groups[0].items.map((item) => item.match)).toEqual([
      { reason: 'name', with: 'jane  doe', sure: true },
      { reason: 'name', with: 'Jane Doe', sure: true },
      { reason: 'alias', with: 'Jane Doe', sure: false },
    ]);
    expect(groups[1].items[1].match).toEqual({
      reason: 'catalog',
      with: 'Mia',
      sure: true,
    });
  });

  it('keeps pairs apart once the entry joining them is split off', () => {
    const withNote = (
      id: string,
      name: string,
      scenes: number,
      note: string,
      aliases: string[] = [],
    ) => ({ ...person(id, name, scenes, aliases), note });
    // Two US pairs, joined only through a UK entry with both names as aliases.
    const groups = groupMergeCandidates([
      withNote('1', 'Ann Lee', 9, 'US'),
      withNote('2', 'ann lee', 2, 'US'),
      withNote('3', 'Bea Cole', 8, 'US'),
      withNote('4', 'bea cole', 1, 'US'),
      withNote('5', 'Cara May', 5, 'UK', ['Ann Lee', 'Bea Cole']),
    ]);
    expect(ids(groups)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('marks as unsure what reaches the one kept only through an alias', () => {
    const groups = groupMergeCandidates([
      person('1', 'JD', 9, ['Jane Doe']),
      person('2', 'Jane Doe', 3),
      person('3', 'jane doe', 2),
    ]);
    expect(groups[0].keepId).toBe('1');
    expect(groups[0].items.map((item) => [item.id, item.match.sure])).toEqual([
      ['1', true],
      ['2', false],
      ['3', false],
    ]);
  });

  it('splits off ones StashDB says are someone else', () => {
    const groups = groupMergeCandidates([
      person('1', 'Lily', 9, [], ['https://stashdb.org/graphql|a']),
      person('2', 'Lily', 5, [], ['https://stashdb.org/graphql|b']),
    ]);
    expect(groups).toEqual([]);
  });
});

describe('cannotBeOne', () => {
  const E = 'https://stashdb.org/graphql';
  const item = (links: string[], note: string | null = null) => ({
    note,
    links,
  });

  it('compares every id on a catalog, whatever order the links come in', () => {
    const two = item([`${E}|aaa`, `${E}|bbb`]);
    expect(cannotBeOne(two, item([`${E}|bbb`]))).toBe(true);
    expect(cannotBeOne(item([`${E}|bbb`]), two)).toBe(true);
    expect(cannotBeOne(two, item([`${E}|bbb`, `${E}|aaa`]))).toBe(false);
    expect(cannotBeOne(two, item(['https://fansdb.cc/graphql|zzz']))).toBe(
      false,
    );
    expect(cannotBeOne(two, item([]))).toBe(false);
  });
});
