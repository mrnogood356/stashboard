import { TestBed } from '@angular/core/testing';
import { AppUpdatesService, mainBundleName } from './app-updates.service';

describe('AppUpdatesService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the release’s main bundle name from a page', () => {
    expect(mainBundleName('<script src="main-WUR5SREH.js" type="module"></script>')).toBe(
      'main-WUR5SREH.js',
    );
    expect(mainBundleName('<script src="main.js"></script>')).toBeNull();
  });

  it('says an update is ready when the server’s page loads a different bundle', async () => {
    const script = document.createElement('script');
    script.src = 'main-AAAAAAAA.js';
    document.head.appendChild(script);
    const fetchMock = vi.fn(async () => new Response('<script src="main-BBBBBBBB.js"></script>'));
    vi.stubGlobal('fetch', fetchMock);

    const service = TestBed.inject(AppUpdatesService);
    await service.check(10 * 60_000);

    expect(fetchMock).toHaveBeenCalledWith('/index.html', { cache: 'no-store' });
    expect(service.updateReady()).toBe(true);
    script.remove();
  });

  it('stays quiet when the bundle is the same, and doesn’t ask again straight away', async () => {
    const script = document.createElement('script');
    script.src = 'main-AAAAAAAA.js';
    document.head.appendChild(script);
    const fetchMock = vi.fn(async () => new Response('<script src="main-AAAAAAAA.js"></script>'));
    vi.stubGlobal('fetch', fetchMock);

    const service = TestBed.inject(AppUpdatesService);
    await service.check(10 * 60_000);
    await service.check(10 * 60_000 + 1_000);

    expect(service.updateReady()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    script.remove();
  });
});
