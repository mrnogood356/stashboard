import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type CatalogProviderKey,
  isCatalogProviderIntegrationType,
} from './catalog-provider.util';

/**
 * Browse pages can ask for a specific catalog provider (for example FansDB next
 * to StashDB) by sending this header. Only catalog lookups honour it; requests,
 * Whisparr and background sync always use the instance's own provider.
 */
export const CATALOG_PROVIDER_HEADER = 'x-catalog-provider';

const storage = new AsyncLocalStorage<{
  requestedProvider: CatalogProviderKey | null;
}>();

export function parseRequestedCatalogProvider(
  value: unknown,
): CatalogProviderKey | null {
  const raw: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toUpperCase();
  return isCatalogProviderIntegrationType(normalized) ? normalized : null;
}

export function runWithRequestedCatalogProvider<T>(
  provider: CatalogProviderKey | null,
  callback: () => T,
): T {
  return storage.run({ requestedProvider: provider }, callback);
}

export function getRequestedCatalogProvider(): CatalogProviderKey | null {
  return storage.getStore()?.requestedProvider ?? null;
}
