import { joinTagNames, splitTagNames } from './tag-names-param';

describe('tag names param', () => {
  it('keeps a name with a comma whole', () => {
    const param = joinTagNames(['Cum, Facial', 'Blonde']);

    expect(splitTagNames(param)).toEqual(['Cum, Facial', 'Blonde']);
  });

  it('reads older links with plain names', () => {
    expect(splitTagNames('Anal,POV')).toEqual(['Anal', 'POV']);
    expect(splitTagNames('100% Real')).toEqual(['100% Real']);
    expect(splitTagNames(null)).toEqual(['']);
  });
});
