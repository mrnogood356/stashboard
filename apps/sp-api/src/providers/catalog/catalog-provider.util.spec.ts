import { IntegrationStatus } from '@prisma/client';
import {
  buildCatalogProviderSelectionConfig,
  instanceCatalogProviderTypeFromIntegrations,
  isBrowseOnlyCatalogKey,
  resolveCatalogProviderKey,
} from './catalog-provider.util';

describe('catalog provider util', () => {
  it('recognises ThePornDB addresses', () => {
    expect(resolveCatalogProviderKey('https://theporndb.net/graphql')).toBe(
      'THEPORNDB',
    );
    expect(isBrowseOnlyCatalogKey('THEPORNDB')).toBe(true);
    expect(isBrowseOnlyCatalogKey('FANSDB')).toBe(false);
  });

  it('never picks ThePornDB as the instance catalog', () => {
    const tpdb = {
      type: 'THEPORNDB',
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'https://theporndb.net/graphql',
      config: buildCatalogProviderSelectionConfig(),
    };
    expect(instanceCatalogProviderTypeFromIntegrations([tpdb])).toBeNull();
    expect(
      instanceCatalogProviderTypeFromIntegrations([
        tpdb,
        { ...tpdb, type: 'STASHDB', baseUrl: 'https://stashdb.org/graphql' },
      ]),
    ).toBe('STASHDB');
  });
});
