import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { HiddenContentService, HiddenContentSettings } from '../api/hidden-content.service';
import { HideOwnedService } from './hide-owned.service';

describe('HideOwnedService', () => {
  const items = [
    { id: 'a', status: { state: 'AVAILABLE' as const } },
    { id: 'b', status: { state: 'NOT_REQUESTED' as const } },
  ];
  const base: HiddenContentSettings = { words: [], tags: [], studios: [], performers: [] };
  let settings: ReturnType<typeof signal<HiddenContentSettings | null>>;
  let saveSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.removeItem('sp-hide-owned');
    localStorage.removeItem('sp-hide-owned-moved');
    settings = signal<HiddenContentSettings | null>(null);
    saveSettings = vi.fn((next: HiddenContentSettings) => {
      settings.set(next);
      return of(next);
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: HiddenContentService,
          useValue: { settings, ensureLoaded: vi.fn(), saveSettings },
        },
      ],
    });
  });

  it('follows the setting saved in Settings → Hidden', () => {
    const service = TestBed.inject(HideOwnedService);
    settings.set({ ...base, hideOwned: false });
    expect(service.filter(items)).toHaveLength(2);

    settings.set({ ...base, hideOwned: true });
    expect(service.filter(items).map((item) => item.id)).toEqual(['b']);
  });

  it('carries the old per-device switch over to the saved setting, once', () => {
    localStorage.setItem('sp-hide-owned', '1');
    const service = TestBed.inject(HideOwnedService);
    expect(service.hideOwned()).toBe(true);

    settings.set({ ...base, hideOwned: false });
    TestBed.tick();

    expect(saveSettings).toHaveBeenCalledWith({ ...base, hideOwned: true });
    expect(localStorage.getItem('sp-hide-owned-moved')).toBe('1');
  });

  it('tries the carry-over again next time when the save fails', () => {
    localStorage.setItem('sp-hide-owned', '1');
    saveSettings.mockReturnValueOnce(throwError(() => new Error('down')));
    TestBed.inject(HideOwnedService);

    settings.set({ ...base, hideOwned: false });
    TestBed.tick();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('sp-hide-owned-moved')).toBeNull();
  });

  it('doesn’t carry it over again once it has', () => {
    localStorage.setItem('sp-hide-owned', '1');
    localStorage.setItem('sp-hide-owned-moved', '1');
    TestBed.inject(HideOwnedService);

    settings.set({ ...base, hideOwned: false });
    TestBed.tick();

    expect(saveSettings).not.toHaveBeenCalled();
    expect(localStorage.getItem('sp-hide-owned')).toBe('0');
  });
});
