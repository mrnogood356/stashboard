import { provideHttpClient, withInterceptors, HttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appLockInterceptor } from '../interceptors/app-lock.interceptor';
import { AppLockService, AppLockStatus } from './app-lock.service';

const status = (overrides: Partial<AppLockStatus> = {}): AppLockStatus => ({
  enabled: true,
  locked: false,
  timeoutSeconds: 60,
  hideInSwitcher: true,
  hasPin: true,
  passkeys: [],
  ...overrides,
});

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('AppLockService', () => {
  let service: AppLockService;
  let http: HttpTestingController;
  const beacon = vi.fn().mockReturnValue(true);

  let phone = true;

  beforeEach(() => {
    phone = true;
    // Installed to a phone's home screen, unless a test says otherwise.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: phone, media: query }),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([appLockInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(AppLockService);
    http = TestBed.inject(HttpTestingController);
    service.start();
  });

  afterEach(() => {
    vi.useRealTimers();
    beacon.mockClear();
    document.documentElement.classList.remove('app-shielded');
    setVisibility('visible');
    http.match(() => true).forEach((req) => req.flush(status()));
    TestBed.resetTestingModule();
  });

  async function load(value: AppLockStatus): Promise<void> {
    const pending = service.refresh();
    http.expectOne('/api/app-lock/status').flush(value);
    await pending;
  }

  it('covers the screen the moment the app goes to the background', async () => {
    await load(status({ enabled: false, hideInSwitcher: true }));
    setVisibility('hidden');
    expect(document.documentElement.classList.contains('app-shielded')).toBe(true);
  });

  it('covers the screen when iOS takes over a touch for the home swipe', async () => {
    const userAgent = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    service.ngOnDestroy();
    service.start();
    await load(status({ enabled: false, hideInSwitcher: true }));
    document.dispatchEvent(new Event('touchcancel'));
    expect(document.documentElement.classList.contains('app-shielded')).toBe(true);

    // Swipe abandoned: the next touch on the app takes the cover down.
    document.dispatchEvent(new Event('touchstart'));
    expect(document.documentElement.classList.contains('app-shielded')).toBe(false);
    userAgent.mockRestore();
  });

  it('ignores cancelled touches elsewhere, where scrolling cancels them', async () => {
    await load(status({ enabled: false, hideInSwitcher: true }));
    document.dispatchEvent(new Event('touchcancel'));
    expect(document.documentElement.classList.contains('app-shielded')).toBe(false);
  });

  it('does nothing in a browser, and only the phone app tells the server', async () => {
    const httpClient = TestBed.inject(HttpClient);
    httpClient.get('/api/anything').subscribe();
    expect(http.expectOne('/api/anything').request.headers.get('X-Stashboard-App')).toBe('phone');

    phone = false;
    service.ngOnDestroy();
    service.start();
    await load(status({ enabled: true, hideInSwitcher: true }));
    setVisibility('hidden');
    expect(document.documentElement.classList.contains('app-shielded')).toBe(false);

    httpClient.get('/api/other').subscribe();
    expect(http.expectOne('/api/other').request.headers.has('X-Stashboard-App')).toBe(false);
  });

  it('does not cover the screen when hiding is turned off and the lock is off', async () => {
    await load(status({ enabled: false, hideInSwitcher: false }));
    setVisibility('hidden');
    expect(document.documentElement.classList.contains('app-shielded')).toBe(false);
  });

  it('locks immediately on leaving when set to "Immediately"', async () => {
    await load(status({ timeoutSeconds: 0 }));
    setVisibility('hidden');

    expect(beacon).toHaveBeenCalledWith('/api/app-lock/lock');
    expect(service.locked()).toBe(true);
  });

  it('locks on return after being away longer than the timeout', async () => {
    await load(status({ timeoutSeconds: 60 }));
    setVisibility('hidden');
    expect(service.locked()).toBe(false);

    vi.setSystemTime(Date.now() + 90_000);
    setVisibility('visible');
    await Promise.resolve();

    expect(service.locked()).toBe(true);
    http.expectOne('/api/app-lock/lock').flush(null);
    expect(document.documentElement.classList.contains('app-shielded')).toBe(false);
  });

  it('stays unlocked after a quick trip away', async () => {
    await load(status({ timeoutSeconds: 300 }));
    setVisibility('hidden');
    vi.setSystemTime(Date.now() + 20_000);
    setVisibility('visible');
    await Promise.resolve();
    http.expectOne('/api/app-lock/status').flush(status({ timeoutSeconds: 300 }));
    await Promise.resolve();

    expect(service.locked()).toBe(false);
  });

  it('tells the server it’s in use while open on screen, so watching never locks it', async () => {
    await load(status({ timeoutSeconds: 60 }));
    const report = () => (service as unknown as { reportActive(): void }).reportActive();

    report();
    http.expectOne('/api/app-lock/active').flush(null);

    setVisibility('hidden');
    report();
    http.expectNone('/api/app-lock/active');

    setVisibility('visible');
    await Promise.resolve();
    http.match('/api/app-lock/status').forEach((req) => req.flush(status({ timeoutSeconds: 60 })));
    service.markLocked();
    report();
    http.expectNone('/api/app-lock/active');
  });

  it('shows the lock screen when the server answers 423 Locked', () => {
    TestBed.inject(HttpClient)
      .get('/api/scenes')
      .subscribe({ error: () => undefined });
    http
      .expectOne('/api/scenes')
      .flush(
        { code: 'APP_LOCKED', message: 'Stashboard is locked.' },
        { status: 423, statusText: 'Locked' },
      );

    expect(service.locked()).toBe(true);
  });

  it('unlocks with the PIN', async () => {
    await load(status({ locked: true }));
    expect(service.locked()).toBe(true);

    const pending = service.unlockWithPin('2468');
    const request = http.expectOne('/api/app-lock/unlock/pin');
    expect(request.request.body).toEqual({ pin: '2468' });
    request.flush(null);
    await pending;

    expect(service.locked()).toBe(false);
  });

  it('never covers the lock screen when iOS cancels a touch on its keypad', async () => {
    const userAgent = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    service.ngOnDestroy();
    service.start();
    await load(status({ locked: true, hideInSwitcher: true }));

    document.dispatchEvent(new Event('touchcancel'));
    window.dispatchEvent(new Event('blur'));

    expect(document.documentElement.classList.contains('app-shielded')).toBe(false);
    userAgent.mockRestore();
  });

  it('gives up on an unlock the server never answers, instead of hanging', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    await load(status({ locked: true }));

    const pending = service.unlockWithPin('2468').catch((error: unknown) => error);
    http.expectOne('/api/app-lock/unlock/pin');
    await vi.advanceTimersByTimeAsync(15_000);

    expect(service.describeError(await pending)).toMatch(/didn’t answer/);
    expect(service.locked()).toBe(true);
  });

  it('doesn’t lock when the app reloads itself, even set to "Immediately"', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign },
    });
    await load(status({ timeoutSeconds: 0 }));

    service.reloadTo('/scenes');
    window.dispatchEvent(new Event('pagehide'));
    setVisibility('hidden');

    expect(assign).toHaveBeenCalledWith('/scenes');
    expect(service.locked()).toBe(false);
    expect(beacon).not.toHaveBeenCalled();
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });
});
