import {
  trimSeparators,
  trimTrailingSeparators,
  trimTrailingSeparatorsKeepFirst,
} from './path-separators';

describe('path separators', () => {
  it('trims / and \\ from the end', () => {
    expect(trimTrailingSeparators('/data/library//')).toBe('/data/library');
    expect(trimTrailingSeparators('C:\\Media\\\\')).toBe('C:\\Media');
    expect(trimTrailingSeparators('/data')).toBe('/data');
    expect(trimTrailingSeparators('/')).toBe('');
    expect(trimTrailingSeparators('')).toBe('');
  });

  it('keeps the first character, so a root stays a root', () => {
    expect(trimTrailingSeparatorsKeepFirst('/')).toBe('/');
    expect(trimTrailingSeparatorsKeepFirst('///')).toBe('/');
    expect(trimTrailingSeparatorsKeepFirst('/downloads/')).toBe('/downloads');
    expect(trimTrailingSeparatorsKeepFirst('a')).toBe('a');
  });

  it('trims both ends', () => {
    expect(trimSeparators('//Studio/Title//')).toBe('Studio/Title');
    expect(trimSeparators('\\a\\')).toBe('a');
    expect(trimSeparators('///')).toBe('');
  });

  it('stays fast on a long run of separators that does not end the path', () => {
    const tricky = `${'/'.repeat(200_000)}x`;
    const started = Date.now();
    expect(trimTrailingSeparators(tricky)).toBe(tricky);
    expect(trimSeparators(tricky)).toBe('x');
    expect(Date.now() - started).toBeLessThan(200);
  });
});
