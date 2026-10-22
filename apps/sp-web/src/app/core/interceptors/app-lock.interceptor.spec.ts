import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLockService } from '../app-lock/app-lock.service';
import { appLockInterceptor } from './app-lock.interceptor';

function setup(isPhoneApp: boolean) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([appLockInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  const appLock = TestBed.inject(AppLockService);
  vi.spyOn(appLock, 'isPhoneApp').mockReturnValue(isPhoneApp);
  vi.spyOn(appLock, 'markLocked');
  return {
    appLock,
    http: TestBed.inject(HttpClient),
    controller: TestBed.inject(HttpTestingController),
  };
}

describe('appLockInterceptor', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('marks requests from the phone app so the server applies App Lock', () => {
    const { http, controller } = setup(true);
    http.get('/api/home').subscribe();
    expect(controller.expectOne('/api/home').request.headers.get('X-Stashboard-App')).toBe('phone');
    controller.verify();
  });

  it('leaves browser requests unmarked', () => {
    const { http, controller } = setup(false);
    http.get('/api/home').subscribe();
    expect(controller.expectOne('/api/home').request.headers.has('X-Stashboard-App')).toBe(false);
    controller.verify();
  });

  it('shows the lock screen when the server says the app is locked, and sends the call again once unlocked', async () => {
    const { http, controller, appLock } = setup(true);
    let result: unknown = 'waiting';
    http.get('/api/home').subscribe({
      next: (body) => (result = body),
      error: (error: { status: number }) => (result = error.status),
    });
    controller
      .expectOne('/api/home')
      .flush({ code: 'APP_LOCKED' }, { status: 423, statusText: 'Locked' });
    await Promise.resolve();

    expect(appLock.markLocked).toHaveBeenCalledTimes(1);
    expect(appLock.locked()).toBe(true);
    expect(result).toBe('waiting');
    controller.expectNone('/api/home');

    const unlocking = appLock.unlockWithPin('1234');
    controller.expectOne('/api/app-lock/unlock/pin').flush(null);
    await unlocking;
    await Promise.resolve();
    controller.expectOne('/api/home').flush({ rails: [] });

    expect(result).toEqual({ rails: [] });
    controller.verify();
  });

  it('sends a request made again while locked only once after unlocking', async () => {
    const { http, controller, appLock } = setup(true);
    const answers: unknown[] = [];
    for (let poll = 0; poll < 3; poll += 1) {
      http.get('/api/status').subscribe((body) => answers.push(body));
      controller
        .expectOne('/api/status')
        .flush({ code: 'APP_LOCKED' }, { status: 423, statusText: 'Locked' });
    }

    const unlocking = appLock.unlockWithPin('1234');
    controller.expectOne('/api/app-lock/unlock/pin').flush(null);
    await unlocking;
    await Promise.resolve();
    controller.expectOne('/api/status').flush({ ok: true });

    expect(answers).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    controller.verify();
  });

  it('does not lock for other errors, or a 423 that is not App Lock', async () => {
    const { http, controller, appLock } = setup(true);
    const first = firstValueFrom(http.get('/api/a')).catch(() => undefined);
    controller.expectOne('/api/a').flush({ code: 'OTHER' }, { status: 423, statusText: 'Locked' });
    const second = firstValueFrom(http.get('/api/b')).catch(() => undefined);
    controller
      .expectOne('/api/b')
      .flush({ code: 'APP_LOCKED' }, { status: 403, statusText: 'Forbidden' });
    await Promise.all([first, second]);

    expect(appLock.markLocked).not.toHaveBeenCalled();
  });
});
