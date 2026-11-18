import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLockService, type AppLockStatus } from '../app-lock/app-lock.service';
import { ImageObscurationService } from './image-obscuration.service';

const STATUS: AppLockStatus = {
  enabled: false,
  locked: false,
  timeoutSeconds: 60,
  hideInSwitcher: true,
  hasPin: false,
  passkeys: [],
};

function setup(options: { phoneApp?: boolean; stored?: string | null } = {}) {
  if (options.stored) {
    localStorage.setItem('sp-images', options.stored);
  }
  const status = signal<AppLockStatus | null>(null);
  const put = vi.fn().mockReturnValue(of(undefined));
  TestBed.configureTestingModule({
    providers: [
      { provide: HttpClient, useValue: { put } },
      {
        provide: AppLockService,
        useValue: { status, isPhoneApp: () => options.phoneApp ?? true },
      },
    ],
  });
  const eye = TestBed.inject(ImageObscurationService);
  const answer = (imagesObscured: boolean | null) => {
    status.set({ ...STATUS, imagesObscured });
    TestBed.tick();
  };
  return { eye, put, answer };
}

describe('ImageObscurationService', () => {
  afterEach(() => {
    localStorage.removeItem('sp-images');
    document.documentElement.removeAttribute('data-images');
    TestBed.resetTestingModule();
  });

  it('puts the phone app’s eye back from the server when iOS cleared the app’s storage', () => {
    const { eye, put, answer } = setup();
    expect(eye.isObscured()).toBe(false);
    answer(true);
    expect(eye.isObscured()).toBe(true);
    expect(localStorage.getItem('sp-images')).toBe('obscured');
    expect(document.documentElement.getAttribute('data-images')).toBe('obscured');
    expect(put).not.toHaveBeenCalled();

    // A change from now on is saved there too.
    eye.toggle();
    expect(put).toHaveBeenLastCalledWith('/api/app-lock/images', { obscured: false });
  });

  it('sends this phone’s eye up the first time, instead of turning it off', () => {
    const { eye, put, answer } = setup({ stored: 'obscured' });
    answer(null);
    expect(eye.isObscured()).toBe(true);
    expect(put).toHaveBeenCalledWith('/api/app-lock/images', { obscured: true });
  });

  it('keeps a change made before the server answered (Blur on open, say)', () => {
    const { eye, put, answer } = setup();
    eye.setMode('obscured');
    answer(false);
    expect(eye.isObscured()).toBe(true);
    expect(put).toHaveBeenCalledWith('/api/app-lock/images', { obscured: true });
  });

  it('leaves a browser on a computer to its own setting', () => {
    const { eye, put, answer } = setup({ phoneApp: false, stored: 'obscured' });
    answer(false);
    eye.toggle();
    expect(eye.isObscured()).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
