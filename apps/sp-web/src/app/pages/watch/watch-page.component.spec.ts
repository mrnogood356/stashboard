import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, Subject, map, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackInfo, PlaybackService } from '../../core/api/playback.service';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import { WatchLaterService } from '../../core/api/watch-later.service';
import { PlayQueueService } from '../../core/play-queue/play-queue.service';
import { signal, type WritableSignal } from '@angular/core';
import { WatchPageComponent } from './watch-page.component';

const baseInfo: PlaybackInfo = {
  sceneId: '12',
  title: 'Evening Scene',
  studio: 'Studio',
  duration: 1800,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  resumeTime: 95,
  playCount: 1,
  posterUrl: '/api/media/stash/scenes/12/screenshot',
  thumbnailsVttUrl: null,
  viewUrl: 'http://stash/scenes/12',
  expiresAt: Math.floor(Date.now() / 1000) + 6 * 3600,
  sources: [
    {
      kind: 'direct',
      label: 'Direct stream',
      mimeType: 'video/mp4',
      resolution: null,
      url: '/api/playback/stream/T/scene/12/stream',
    },
    {
      kind: 'mp4',
      label: 'MP4',
      mimeType: 'video/mp4',
      resolution: 'ORIGINAL',
      url: '/api/playback/stream/T/scene/12/stream.mp4?resolution=ORIGINAL',
    },
  ],
};

describe('WatchPageComponent', () => {
  let playback: {
    getInfo: ReturnType<typeof vi.fn>;
    saveActivity: ReturnType<typeof vi.fn>;
    addPlay: ReturnType<typeof vi.fn>;
    saveActivityOnExit: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // jsdom has no media playback; stub what the player calls.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type: string) =>
      type.startsWith('video/mp4') ? 'probably' : '',
    );
    playback = {
      getInfo: vi.fn().mockReturnValue(of(baseInfo)),
      saveActivity: vi.fn().mockReturnValue(of(undefined)),
      addPlay: vi.fn().mockReturnValue(of(undefined)),
      saveActivityOnExit: vi.fn(),
    };
  });

  let library: {
    related: ReturnType<typeof vi.fn>;
    addMarker: ReturnType<typeof vi.fn>;
    searchTags: ReturnType<typeof vi.fn>;
  };
  let router: { navigateByUrl: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };
  let watchLater: {
    ensureLoaded: ReturnType<typeof vi.fn>;
    has: ReturnType<typeof vi.fn>;
    toggle: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    library = {
      related: vi.fn().mockReturnValue(of([])),
      addMarker: vi
        .fn()
        .mockReturnValue(
          of({ markers: [{ id: 'new', title: 'Pool', seconds: 300, imageUrl: '/m' }] }),
        ),
      searchTags: vi.fn().mockReturnValue(of([{ id: '7', name: 'Pool' }])),
    };
    router = { navigateByUrl: vi.fn(), navigate: vi.fn().mockResolvedValue(true) };
    watchLater = {
      ensureLoaded: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      toggle: vi.fn().mockReturnValue(of([])),
      remove: vi.fn().mockReturnValue(of([])),
    };
    sessionStorage.removeItem('stashboard.playQueue');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  async function render(
    options: {
      sceneIds?: BehaviorSubject<string>;
      locked?: ReturnType<typeof signal<boolean>>;
      returnTo?: string;
    } = {},
  ) {
    const sceneIds = options.sceneIds ?? new BehaviorSubject('12');
    await TestBed.configureTestingModule({
      imports: [WatchPageComponent],
      providers: [
        { provide: PlaybackService, useValue: playback },
        { provide: LocalLibraryService, useValue: library },
        { provide: WatchLaterService, useValue: watchLater },
        {
          provide: AppLockService,
          useValue: {
            locked: options.locked ?? signal(false),
            refresh: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: sceneIds.pipe(map((sceneId) => convertToParamMap({ sceneId }))),
            snapshot: {
              paramMap: convertToParamMap({ sceneId: sceneIds.value }),
              queryParamMap: convertToParamMap({ returnTo: options.returnTo ?? '/library' }),
            },
          },
        },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(WatchPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('starts the original file and offers to start over from the resume point', async () => {
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;

    expect(playback.getInfo).toHaveBeenCalledWith('12');
    expect(video.getAttribute('src') ?? video.src).toContain('/scene/12/stream');
    expect(video.hasAttribute('playsinline')).toBe(true);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Evening Scene');
    expect(text).toContain('Resumed at 1:35');
    expect(text).toContain('Start over');
  });

  it('falls back to the converted stream when the original fails', async () => {
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;

    video.dispatchEvent(new Event('error'));
    await fixture.whenStable();

    expect(video.src).toContain('stream.mp4?resolution=ORIGINAL');
  });

  it('saves the position to Stash when paused', async () => {
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 300, writable: true });

    video.dispatchEvent(new Event('pause'));

    expect(playback.saveActivity).toHaveBeenCalledWith('12', 300, expect.any(Number));
  });

  it('saves progress when the app is hidden or closed', async () => {
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 420, writable: true });

    window.dispatchEvent(new Event('pagehide'));

    expect(playback.saveActivityOnExit).toHaveBeenCalledWith('12', 420, expect.any(Number));
  });

  it('explains when the scene is not in Stash', async () => {
    playback.getInfo.mockReturnValue(
      throwError(() => ({
        status: 404,
        error: { message: 'That scene is not in your Stash library.' },
      })),
    );
    const fixture = await render();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('That scene is not in your Stash library.');
    expect(text).toContain('Go back');
    expect(text).toContain('Unavailable');
  });

  it('marks chapters on the seek bar and jumps to one from the menu', async () => {
    playback.getInfo.mockReturnValue(
      of({
        ...baseInfo,
        markers: [
          { id: 'm1', title: 'Intro', seconds: 0, imageUrl: '/m1' },
          { id: 'm2', title: 'Beach', seconds: 900, imageUrl: '/m2', previewUrl: '/m2.mp4' },
        ],
      }),
    );
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;

    // Only chapters inside the video get a mark (not one at 0:00).
    const ticks = fixture.nativeElement.querySelectorAll(
      '.seek-chapter',
    ) as NodeListOf<HTMLElement>;
    expect(ticks.length).toBe(1);
    expect(ticks[0].style.left).toBe('50%');

    (fixture.nativeElement.querySelector('[aria-label="Chapters"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const items = Array.from(
      fixture.nativeElement.querySelectorAll(
        '.chapters-menu [role="menuitem"]',
      ) as NodeListOf<HTMLButtonElement>,
    );
    expect(items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '0:00Intro',
      '15:00Beach',
    ]);
    // Each chapter shows its picture, ready to play Stash's marker clip.
    expect(
      items.map((item) => item.querySelector('.chapter-thumb img')?.getAttribute('src')),
    ).toEqual(['/m1', '/m2']);
    items[1].click();
    expect(video.currentTime).toBe(900);

    // On a phone, the Next chapter button does what ] does.
    video.currentTime = 10;
    (
      fixture.nativeElement.querySelector('[data-testid="next-chapter"]') as HTMLButtonElement
    ).click();
    expect(video.currentTime).toBe(900);
  });

  it('offers the next related scene when this one ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    library.related.mockReturnValue(
      of([
        {
          id: '13',
          title: 'Next Scene',
          imageUrl: null,
          cardImageUrl: '/next.jpg',
          studioId: null,
          studio: null,
          studioImageUrl: null,
          releaseDate: null,
          duration: 600,
          playCount: 0,
          progress: null,
          type: 'SCENE',
          source: 'STASH',
        },
      ]),
    );
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;

    video.dispatchEvent(new Event('ended'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.up-next')?.textContent).toContain('Next Scene');

    vi.advanceTimersByTime(8000);
    expect(router.navigate).toHaveBeenCalledWith(['/watch', '13'], {
      queryParams: { returnTo: '/library' },
      replaceUrl: true,
    });
    vi.useRealTimers();
  });

  it('plays a Watch later list in order, and a scene played to the end leaves the list', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sessionStorage.setItem(
      'stashboard.playQueue',
      JSON.stringify({
        label: 'Watch later',
        kind: 'later',
        index: 0,
        items: [
          { sceneId: '12', title: 'Evening Scene', imageUrl: null },
          { sceneId: '40', title: 'Saved Scene', imageUrl: null },
        ],
      }),
    );
    const fixture = await render();
    expect(library.related).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement.querySelector('[data-testid="queue-label"]').textContent,
    ).toContain('Watch later · 1 of 2');
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;

    video.dispatchEvent(new Event('ended'));
    fixture.detectChanges();
    expect(watchLater.remove).toHaveBeenCalledWith('12');
    expect(fixture.nativeElement.querySelector('.up-next')?.textContent).toContain('Saved Scene');
    vi.advanceTimersByTime(8000);
    expect(router.navigate).toHaveBeenCalledWith(['/watch', '40'], {
      queryParams: { returnTo: '/library' },
      replaceUrl: true,
    });
    expect(TestBed.inject(PlayQueueService).queue()?.index).toBe(1);
    vi.useRealTimers();
  });

  it('plays a chapter list: starts at the chapter, and goes on when it ends', async () => {
    sessionStorage.setItem(
      'stashboard.playQueue',
      JSON.stringify({
        label: 'Chapters',
        kind: 'chapters',
        index: 0,
        items: [
          { sceneId: '12', title: 'Beach', imageUrl: null, start: 300, end: 330 },
          { sceneId: '12', title: 'Pool', imageUrl: null, start: 900, end: 940 },
          { sceneId: '55', title: 'Roof', imageUrl: null, start: 60, end: 90 },
        ],
      }),
    );
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(300);
    // No resume toast for a chapter.
    expect(fixture.nativeElement.querySelector('.resume-toast')).toBeNull();

    // The next chapter is in the same scene: it jumps there.
    video.currentTime = 331;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBe(900);
    expect(router.navigate).not.toHaveBeenCalled();

    // Then on to another scene.
    video.currentTime = 941;
    video.dispatchEvent(new Event('timeupdate'));
    expect(router.navigate).toHaveBeenCalledWith(['/watch', '55'], expect.anything());
  });

  it('lets you cancel Up next', async () => {
    library.related.mockReturnValue(
      of([{ id: '13', title: 'Next Scene', cardImageUrl: null, imageUrl: null }]),
    );
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;

    video.dispatchEvent(new Event('ended'));
    fixture.detectChanges();
    const cancel = Array.from(
      fixture.nativeElement.querySelectorAll('.up-next button') as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.includes('Cancel'));
    cancel!.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.up-next')).toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('adds a chapter at the current time with a tag', async () => {
    localStorage.removeItem('stashboard.lastMarkerTag');
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      value: 300.7,
      writable: true,
    });

    (
      fixture.nativeElement.querySelector('[aria-label="Add chapter"]') as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    const sheet = fixture.nativeElement.querySelector('.chapter-sheet') as HTMLElement;
    expect(sheet.textContent).toContain('Add chapter at 5:00');

    const tagInput = sheet.querySelector('input[type="search"]') as HTMLInputElement;
    tagInput.value = 'po';
    tagInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (sheet.querySelector('.sheet-results button') as HTMLButtonElement).click();
    fixture.detectChanges();
    // Clicking the picked tag's name must not hit its "Change tag" button.
    (sheet.querySelector('.picked-tag') as HTMLElement).click();
    fixture.detectChanges();
    expect(sheet.querySelector('.picked-tag')?.textContent).toContain('Pool');
    (
      fixture.nativeElement.querySelector(
        '.chapter-sheet button[type="submit"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(library.addMarker).toHaveBeenCalledWith('12', {
      title: 'Pool',
      seconds: 300,
      primaryTagId: '7',
    });
    expect(fixture.nativeElement.querySelector('.chapter-sheet')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.seek-chapter').length).toBe(1);
  });

  it('starts nothing when the scene answers after you left the page', async () => {
    const answer = new Subject<PlaybackInfo>();
    playback.getInfo.mockReturnValue(answer);
    const fixture = await render();
    const play = vi.mocked(HTMLMediaElement.prototype.play);

    fixture.destroy();
    answer.next(baseInfo);

    expect(play).not.toHaveBeenCalled();
  });

  it('ignores a late answer for the scene you switched away from', async () => {
    const sceneIds = new BehaviorSubject('12');
    const first = new Subject<PlaybackInfo>();
    playback.getInfo
      .mockReturnValueOnce(first)
      .mockReturnValue(of({ ...baseInfo, sceneId: '13', title: 'Next Scene' }));
    const fixture = await render({ sceneIds });

    sceneIds.next('13');
    first.next(baseInfo);
    fixture.detectChanges();

    expect(playback.getInfo).toHaveBeenLastCalledWith('13');
    expect(fixture.nativeElement.textContent).toContain('Next Scene');
    expect(fixture.nativeElement.textContent).not.toContain('Evening Scene');
    fixture.destroy();
  });

  it('jumps by number, steps chapters, changes speed and volume from the keyboard', async () => {
    playback.getInfo.mockReturnValue(
      of({
        ...baseInfo,
        markers: [
          { id: 'm1', title: 'Intro', seconds: 0, imageUrl: '/m1' },
          { id: 'm2', title: 'Beach', seconds: 900, imageUrl: '/m2' },
        ],
      }),
    );
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    const press = (key: string) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key }));
      fixture.detectChanges();
    };
    const hud = () =>
      (
        fixture.nativeElement.querySelector('[data-testid="player-hud"]') as HTMLElement | null
      )?.textContent?.trim();

    press('2');
    expect(video.currentTime).toBe(360);
    press(']');
    expect(video.currentTime).toBe(900);
    expect(hud()).toBe('Beach');

    press('>');
    expect(video.playbackRate).toBe(1.25);
    expect(
      (fixture.nativeElement.querySelector('[data-testid="speed-button"]') as HTMLElement)
        .textContent,
    ).toContain('1.25×');

    video.volume = 0.5;
    press('ArrowDown');
    expect(video.volume).toBe(0.4);
    expect(hud()).toBe('Volume 40%');
    expect(localStorage.getItem('stashboard.player.volume')).toBe('0.4');
    localStorage.removeItem('stashboard.player.volume');
  });

  it('loops between two points with A, goes round at the end, and mirrors with X', async () => {
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { configurable: true, value: 1800 });
    video.dispatchEvent(new Event('loadedmetadata'));
    const press = (key: string) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key }));
      fixture.detectChanges();
    };
    video.currentTime = 100;
    press('a');
    video.currentTime = 100.2;
    press('a');
    // Too close to the start: still waiting for the end.
    expect(fixture.nativeElement.querySelector('[data-testid="player-hud"]').textContent).toContain(
      'after the start',
    );
    video.currentTime = 160;
    press('a');
    expect(video.currentTime).toBe(100);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="seek-loop"]')).not.toBeNull();

    video.currentTime = 161;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBe(100);

    // Esc turns the loop off before it would leave the player.
    press('Escape');
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="seek-loop"]')).toBeNull();

    press('x');
    expect(video.classList.contains('mirrored')).toBe(true);
    press('x');
    expect(video.classList.contains('mirrored')).toBe(false);
  });

  it('loops a chapter from the chapter list', async () => {
    playback.getInfo.mockReturnValue(
      of({
        ...baseInfo,
        markers: [
          { id: 'm1', title: 'Intro', seconds: 0, imageUrl: '/m1' },
          { id: 'm2', title: 'Beach', seconds: 900, imageUrl: '/m2' },
          { id: 'm3', title: 'Pool', seconds: 1200, imageUrl: '/m3' },
        ],
      }),
    );
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    (fixture.nativeElement.querySelector('[aria-label="Chapters"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelector('[aria-label="Loop chapter Beach"]') as HTMLButtonElement
    ).click();
    expect(video.currentTime).toBe(900);
    video.currentTime = 1201;
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.currentTime).toBe(900);
  });

  it('keeps a muted video muted when you turn the volume down', async () => {
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    video.volume = 0.5;
    video.muted = true;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(video.volume).toBe(0.4);
    expect(video.muted).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(video.muted).toBe(false);
    localStorage.removeItem('stashboard.player.volume');
  });

  it('lists the shortcuts with "?", and any key closes the list', async () => {
    const fixture = await render();
    const shortcuts = () => fixture.nativeElement.querySelector('[data-testid="player-shortcuts"]');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    fixture.detectChanges();
    expect(shortcuts()?.textContent).toContain('Jump to 0%–90%');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(shortcuts()).toBeNull();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('never pauses on a click on the picture: it closes a menu, else shows the controls', async () => {
    const fixture = await render();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const component = fixture.componentInstance as unknown as {
      speedMenuOpen: WritableSignal<boolean>;
      controlsVisible: WritableSignal<boolean>;
    };
    const surface = fixture.nativeElement.querySelector('.surface') as HTMLElement;

    component.speedMenuOpen.set(true);
    surface.dispatchEvent(new PointerEvent('click', { pointerType: 'mouse', bubbles: true }));
    expect(component.speedMenuOpen()).toBe(false);

    component.controlsVisible.set(false);
    // Past the double-click window.
    await new Promise((resolve) => setTimeout(resolve, 320));
    surface.dispatchEvent(new PointerEvent('click', { pointerType: 'mouse', bubbles: true }));
    expect(component.controlsVisible()).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    pause.mockRestore();
    fixture.destroy();
  });

  it('treats a tap as a tap when iOS reports its click as a mouse, and a menu-closing tap never counts as a double tap', async () => {
    const fixture = await render();
    const component = fixture.componentInstance as unknown as {
      speedMenuOpen: WritableSignal<boolean>;
      controlsVisible: WritableSignal<boolean>;
      skip(seconds: number): void;
    };
    const skip = vi.spyOn(component, 'skip');
    const surface = fixture.nativeElement.querySelector('.surface') as HTMLElement;
    const tap = (clientX: number) => {
      surface.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX }));
      surface.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientX }));
      // iOS Safari: the click says "mouse".
      surface.dispatchEvent(
        new PointerEvent('click', { pointerType: 'mouse', clientX, bubbles: true }),
      );
    };

    component.controlsVisible.set(true);
    tap(10);
    // Touch behaviour: the tap toggled the controls rather than only showing them.
    expect(component.controlsVisible()).toBe(true);

    component.speedMenuOpen.set(true);
    await new Promise((resolve) => setTimeout(resolve, 320));
    tap(10);
    expect(component.speedMenuOpen()).toBe(false);
    tap(10);
    expect(skip).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('plays at 2× while you hold the picture, then goes back to your speed', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await render();
      const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
      const surface = fixture.nativeElement.querySelector('.surface') as HTMLElement;

      surface.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' }));
      vi.advanceTimersByTime(500);
      fixture.detectChanges();
      expect(video.playbackRate).toBe(2);
      expect(fixture.nativeElement.querySelector('.hold-badge')).toBeTruthy();

      surface.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
      fixture.detectChanges();
      expect(video.playbackRate).toBe(1);
      expect(fixture.nativeElement.querySelector('.hold-badge')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores player keys while App Lock is up', async () => {
    const locked = signal(false);
    const fixture = await render({ locked });
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();

    locked.set(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));

    expect(play).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('goes back only to a path inside the app', async () => {
    const fixture = await render({ returnTo: '//evil.example' });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    (fixture.componentInstance as any).goBack();

    expect(router.navigateByUrl).not.toHaveBeenCalledWith('//evil.example');
    back.mockRestore();
    fixture.destroy();
  });
});
