import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/api/auth.service';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import { AppLockScreenComponent } from './app-lock-screen.component';

describe('AppLockScreenComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(appLock: Partial<Record<string, unknown>>) {
    await TestBed.configureTestingModule({
      imports: [AppLockScreenComponent],
      providers: [
        { provide: AppLockService, useValue: appLock },
        { provide: AuthService, useValue: { logout: () => of({}) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppLockScreenComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  function lockService(overrides: Record<string, unknown> = {}) {
    return {
      locked: signal(true),
      faceIdReady: signal(false),
      unlockWithPin: vi.fn().mockResolvedValue(undefined),
      unlockWithFaceId: vi.fn().mockResolvedValue(undefined),
      describeError: (error: unknown) =>
        error instanceof HttpErrorResponse && error.status === 403 ? 'Wrong PIN.' : 'Error',
      ...overrides,
    };
  }

  function tap(fixture: { nativeElement: HTMLElement }, label: string): void {
    const button = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === label,
    ) as HTMLButtonElement;
    button.click();
  }

  it('shows nothing when unlocked', async () => {
    const fixture = await render(lockService({ locked: signal(false) }));
    expect(fixture.nativeElement.querySelector('.lock')).toBeNull();
  });

  it('enters a PIN on the keypad and unlocks', async () => {
    const appLock = lockService();
    const fixture = await render(appLock);
    expect(fixture.nativeElement.textContent).toContain('Stashboard is locked');

    ['2', '4', '6', '8'].forEach((digit) => tap(fixture, digit));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.dot.filled')).toHaveLength(4);

    tap(fixture, 'Unlock');
    await fixture.whenStable();
    expect(appLock.unlockWithPin).toHaveBeenCalledWith('2468');
  });

  it('clears the PIN and explains a wrong one', async () => {
    const appLock = lockService({
      unlockWithPin: vi.fn().mockRejectedValue(new HttpErrorResponse({ status: 403 })),
    });
    const fixture = await render(appLock);
    ['1', '1', '1', '1'].forEach((digit) => tap(fixture, digit));
    fixture.detectChanges();
    tap(fixture, 'Unlock');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Wrong PIN.');
    expect(fixture.nativeElement.querySelectorAll('.dot.filled')).toHaveLength(0);
  });

  it('offers Face ID when it is set up', async () => {
    const appLock = lockService({ faceIdReady: signal(true) });
    const fixture = await render(appLock);
    const faceId = fixture.nativeElement.querySelector(
      'button[aria-label="Unlock with Face ID"]',
    ) as HTMLButtonElement;

    expect(faceId).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Use Face ID or enter your PIN');
  });

  it('lets Enter press a focused button instead of submitting the PIN', async () => {
    const appLock = lockService();
    const fixture = await render(appLock);
    ['1', '2', '3', '4'].forEach((digit) => tap(fixture, digit));
    const logOut = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((b) => b.textContent?.includes('Log out')) as HTMLButtonElement;

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    logOut.dispatchEvent(event);

    expect(appLock.unlockWithPin).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('makes the page behind the lock unreachable while locked', async () => {
    const locked = signal(false);
    const fixture = await render(lockService({ locked }));
    const page = document.createElement('main');
    fixture.nativeElement.parentElement.appendChild(page);

    locked.set(true);
    fixture.detectChanges();
    expect(page.inert).toBe(true);

    locked.set(false);
    fixture.detectChanges();
    expect(page.inert).toBe(false);
    page.remove();
  });
});
