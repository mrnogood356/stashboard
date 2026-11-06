import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageObscurationService } from '../preferences/image-obscuration.service';
import { QUICK_HIDE_KEY, QuickHideService } from './quick-hide.service';

function tap(x = 100, y = 100): void {
  const event = new Event('pointerdown') as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: 'touch' },
    clientX: { value: x },
    clientY: { value: y },
  });
  window.dispatchEvent(event);
}

function esc(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

describe('QuickHideService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.removeItem(QUICK_HIDE_KEY);
  });

  afterEach(() => {
    TestBed.inject(ImageObscurationService).setMode('clear');
    TestBed.resetTestingModule();
    localStorage.removeItem(QUICK_HIDE_KEY);
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function start(settings?: object): { service: QuickHideService; obscured: () => boolean } {
    if (settings) {
      localStorage.setItem(QUICK_HIDE_KEY, JSON.stringify(settings));
    }
    const service = TestBed.inject(QuickHideService);
    service.start();
    const obscuration = TestBed.inject(ImageObscurationService);
    return { service, obscured: () => obscuration.isObscured() };
  }

  it('hides on Esc twice: covers the screen, pauses video and blurs pictures', () => {
    const video = document.createElement('video');
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    document.body.appendChild(video);
    const { service, obscured } = start();

    esc();
    expect(service.hidden()).toBe(false);
    esc();

    expect(service.hidden()).toBe(true);
    expect(pause).toHaveBeenCalled();
    expect(obscured()).toBe(true);

    service.reveal();
    expect(service.hidden()).toBe(false);
    // Back as it was: pictures were clear before hiding.
    expect(obscured()).toBe(false);
  });

  it('keeps pictures blurred on the way back when they were blurred before', () => {
    const { service, obscured } = start();
    TestBed.inject(ImageObscurationService).setMode('obscured');
    service.hide();
    service.reveal();
    expect(obscured()).toBe(true);
  });

  it('lets no key reach the page while the cover is up', () => {
    const { service } = start();
    service.hide();
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    document.removeEventListener('keydown', heard);
    expect(heard).not.toHaveBeenCalled();
  });

  it('does not hide on two Escs far apart', () => {
    const { service } = start();
    esc();
    vi.advanceTimersByTime(1000);
    esc();
    expect(service.hidden()).toBe(false);
  });

  it('hides on three quick taps in one place, not on taps spread out', () => {
    const { service } = start();
    tap(10, 10);
    tap(300, 300);
    tap(10, 10);
    expect(service.hidden()).toBe(false);

    tap();
    tap();
    tap();
    expect(service.hidden()).toBe(true);
  });

  it('does nothing with the gesture off', () => {
    const { service } = start({ gesture: false });
    esc();
    esc();
    tap();
    tap();
    tap();
    expect(service.hidden()).toBe(false);
  });

  it('blurs pictures on open, and after the idle time', () => {
    expect(start({ obscureOnOpen: true }).obscured()).toBe(true);
    TestBed.inject(ImageObscurationService).setMode('clear');
    TestBed.resetTestingModule();

    const { service, obscured } = start({ idleMinutes: 5 });
    service.checkIdle(Date.now() + 4 * 60_000);
    expect(obscured()).toBe(false);
    service.checkIdle(Date.now() + 5 * 60_000);
    expect(obscured()).toBe(true);
  });

  it('remembers its settings on this device', () => {
    const { service } = start();
    service.save({ gesture: false, obscureOnOpen: true, idleMinutes: 15 });
    expect(JSON.parse(localStorage.getItem(QUICK_HIDE_KEY) ?? '{}')).toEqual({
      gesture: false,
      obscureOnOpen: true,
      idleMinutes: 15,
    });
  });
});
