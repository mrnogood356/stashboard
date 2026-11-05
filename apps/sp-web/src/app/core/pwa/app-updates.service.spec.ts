import { TestBed } from '@angular/core/testing';
import { AppUpdatesService, mainBundleName } from './app-updates.service';

describe('AppUpdatesService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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

  it('keeps Safari’s Add to Dock steps on http://, as Safari adds any page', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    );
    const service = TestBed.inject(AppUpdatesService);
    service.start();
    expect(service.installState()).toBe('manual');
  });

  it('says why there’s no Install on a plain http:// address', () => {
    vi.stubGlobal('isSecureContext', false);
    const service = TestBed.inject(AppUpdatesService);
    service.start();
    expect(service.installState()).toBe('insecure');
  });
});
