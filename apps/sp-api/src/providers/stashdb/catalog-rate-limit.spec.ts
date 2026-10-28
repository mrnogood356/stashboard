import {
  pauseCatalog,
  resetCatalogRateLimit,
  withCatalogSlot,
} from './catalog-rate-limit';

describe('catalog rate limit', () => {
  beforeEach(() => resetCatalogRateLimit());

  it('keeps servers apart', async () => {
    const started = Date.now();
    await Promise.all([
      withCatalogSlot('stashdb.org', () => Promise.resolve()),
      withCatalogSlot('fansdb.cc', () => Promise.resolve()),
    ]);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('reads Retry-After as seconds or a date, and holds at most five minutes', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(pauseCatalog('a', '12', now)).toBe(12_000);
    expect(pauseCatalog('b', 'Wed, 28 Oct 2026 12:01:00 GMT', now)).toBe(
      60_000,
    );
    expect(pauseCatalog('c', null, now)).toBe(30_000);
    expect(pauseCatalog('d', '86400', now)).toBe(5 * 60_000);
  });

  it('keeps waiting when the pause grows while it waits', async () => {
    pauseCatalog('stashdb.org', '0.2');
    const started = Date.now();
    setTimeout(() => pauseCatalog('stashdb.org', '0.4'), 100);
    await withCatalogSlot('stashdb.org', () => Promise.resolve());
    expect(Date.now() - started).toBeGreaterThanOrEqual(480);
  });

  it('waits out a pause before the next request', async () => {
    pauseCatalog('stashdb.org', '0.3');
    const started = Date.now();
    await withCatalogSlot('stashdb.org', () => Promise.resolve());
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });
});
