import { keptAcrossCatalogs } from './catalog-provider-switch.component';

describe('keptAcrossCatalogs', () => {
  it('keeps tags with their names, sort and words, and drops studios', () => {
    expect(
      keptAcrossCatalogs(
        '/scenes',
        '?tags=a,b&tagNames=Anal,POV&mode=AND&sort=DATE&dir=DESC&exclude=trans&studios=s1&studioNames=S',
      ),
    ).toBe('/scenes?tags=a%2Cb&tagNames=Anal%2CPOV&mode=AND&sort=DATE&dir=DESC&exclude=trans');
  });

  it('drops tag ids that come without names', () => {
    expect(keptAcrossCatalogs('/scenes', '?tags=a&mode=OR&sort=DATE')).toBe('/scenes?sort=DATE');
  });

  it('keeps a plain address plain', () => {
    expect(keptAcrossCatalogs('/scenes', '')).toBe('/scenes');
  });
});
