import { dropBracketed } from './match-scoring.util';

describe('dropBracketed', () => {
  it('replaces each [...] and {...} group with a space', () => {
    expect(dropBracketed('Title [1080p] {web}-GRP')).toBe('Title    -GRP');
    expect(dropBracketed('[a[b]c]')).toBe(' c]');
    expect(dropBracketed('no groups')).toBe('no groups');
  });

  it('keeps a bracket that is never closed', () => {
    expect(dropBracketed('Title [unclosed {x} end')).toBe(
      'Title [unclosed   end',
    );
  });

  it('matches the regex it replaced', () => {
    const old = (text: string) => text.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
    const alphabet = ['[', ']', '{', '}', 'a', ' ', '-'];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 2000; round += 1) {
      const length = next() % 16;
      let text = '';
      for (let i = 0; i < length; i += 1) {
        text += alphabet[next() % alphabet.length];
      }
      expect(dropBracketed(text)).toBe(old(text));
    }
  });

  it('stays fast on a long run of unclosed brackets', () => {
    const tricky = '['.repeat(200_000);
    const started = Date.now();
    expect(dropBracketed(tricky)).toBe(tricky);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
