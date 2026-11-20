import { describe, expect, it } from 'vitest';
import { fromProwlarr, type ProwlarrRelease } from './releases.service';

describe('fromProwlarr', () => {
  const prowlarr = (overrides: Partial<ProwlarrRelease> = {}): ProwlarrRelease => ({
    guid: 'g1',
    indexerId: 7,
    indexer: 'Tracker',
    title: 'Jane.Doe.24.03.15',
    size: 1e9,
    protocol: 'usenet',
    seeders: null,
    leechers: null,
    ageHours: 2,
    publishDate: null,
    infoUrl: null,
    match: null,
    ...overrides,
  });

  it('keeps why a release failed before, so the list can say so', () => {
    expect(fromProwlarr(prowlarr({ failedBefore: 'Aborted.' })).failedBefore).toBe('Aborted.');
    expect('failedBefore' in fromProwlarr(prowlarr())).toBe(false);
  });
});
