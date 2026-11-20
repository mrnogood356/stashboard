import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { IdlePreloading, shouldPreload } from './idle-preloading';

const withConnection = (connection: object | undefined) => ({ connection }) as unknown as Navigator;

describe('shouldPreload', () => {
  it('preloads when the browser says nothing about the connection', () => {
    expect(shouldPreload(withConnection(undefined))).toBe(true);
    expect(shouldPreload(undefined)).toBe(true);
  });

  it('preloads on a 4G connection', () => {
    expect(shouldPreload(withConnection({ effectiveType: '4g' }))).toBe(true);
  });

  it('skips on Data Saver', () => {
    expect(shouldPreload(withConnection({ saveData: true, effectiveType: '4g' }))).toBe(false);
  });

  it('skips on 2G-class connections', () => {
    expect(shouldPreload(withConnection({ effectiveType: '2g' }))).toBe(false);
    expect(shouldPreload(withConnection({ effectiveType: 'slow-2g' }))).toBe(false);
  });
});

describe('IdlePreloading', () => {
  it('loads the page once the browser is idle', async () => {
    const load = vi.fn(() => of('page'));
    await expect(firstValueFrom(new IdlePreloading().preload({}, load))).resolves.toBe('page');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed load, like PreloadAllModules', async () => {
    const load = () => throwError(() => new Error('offline'));
    await expect(firstValueFrom(new IdlePreloading().preload({}, load))).resolves.toBeNull();
  });

  it('skips the download when the connection turned to 2G while waiting', async () => {
    const connection = { effectiveType: '4g' };
    vi.stubGlobal('navigator', { connection });
    try {
      const load = vi.fn(() => of('page'));
      const preloaded = firstValueFrom(new IdlePreloading().preload({}, load));
      connection.effectiveType = '2g';
      await expect(preloaded).resolves.toBeNull();
      expect(load).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
