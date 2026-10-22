import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import { FeedPageComponent } from './feed-page.component';

describe('FeedPageComponent', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    localStorage.removeItem('stashboard.feedSound');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('shows shuffled library scenes with preview clips and a Play button', async () => {
    const items = ['1', '2', '3'].map((id) => ({
      id,
      title: `Scene ${id}`,
      imageUrl: `/img/${id}`,
      cardImageUrl: null,
      studioId: null,
      studio: 'Studio',
      studioImageUrl: null,
      releaseDate: '2025-01-01',
      duration: 600,
      playCount: 0,
      progress: null,
      type: 'SCENE',
      source: 'STASH',
    }));
    const library = {
      feed: vi.fn().mockReturnValue(of({ total: 3, page: 1, hasMore: false, items })),
    };
    await TestBed.configureTestingModule({
      imports: [FeedPageComponent],
      providers: [provideRouter([]), { provide: LocalLibraryService, useValue: library }],
    }).compileComponents();
    const fixture = TestBed.createComponent(FeedPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(library.feed).toHaveBeenCalledWith(1, expect.any(Number));
    expect(root.querySelectorAll('.slide').length).toBe(3);
    // Only the first two (on screen and next) get a video; the rest stay pictures.
    expect(root.querySelectorAll('video').length).toBe(2);
    expect(root.querySelector('video')?.getAttribute('src')).toBe('/api/playback/scenes/1/preview');
    expect(root.querySelector('.slide .round.primary')?.getAttribute('href')).toContain('/watch/1');

    root.querySelector<HTMLButtonElement>('[aria-label="Sound on"]')!.click();
    expect(localStorage.getItem('stashboard.feedSound')).toBe('1');
  });

  it('checks App Lock, and stops the clips and keys while locked', async () => {
    const item = {
      id: '1',
      title: 'Scene 1',
      imageUrl: '/img/1',
      cardImageUrl: null,
      studioId: null,
      studio: null,
      studioImageUrl: null,
      releaseDate: null,
      duration: 600,
      playCount: 0,
      progress: null,
      type: 'SCENE',
      source: 'STASH',
    };
    const appLock = { locked: signal(false), refresh: vi.fn().mockResolvedValue(null) };
    await TestBed.configureTestingModule({
      imports: [FeedPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: LocalLibraryService,
          useValue: {
            feed: vi
              .fn()
              .mockReturnValue(
                of({ total: 2, page: 1, hasMore: false, items: [item, { ...item, id: '2' }] }),
              ),
          },
        },
        { provide: AppLockService, useValue: appLock },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FeedPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();

    expect(appLock.refresh).toHaveBeenCalled();
    appLock.locked.set(true);
    fixture.detectChanges();
    expect(pause).toHaveBeenCalled();

    const component = fixture.componentInstance as any;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(component.active()).toBe(0);
  });
});
