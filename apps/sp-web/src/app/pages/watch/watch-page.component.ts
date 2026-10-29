import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type Hls from 'hls.js';
import { PlaybackInfo, PlaybackService, SceneMarker } from '../../core/api/playback.service';
import { LocalLibraryService, LocalSceneCard } from '../../core/api/local-library.service';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import {
  FRAME_SECONDS,
  PLAYER_SHORTCUTS,
  SKIP_SECONDS,
  SPEEDS,
  playerKeyAction,
  speedLabel,
  stepSpeed,
} from './player-keys';
import {
  PlaybackCandidate,
  PlayerEnvironment,
  QualityOption,
  ThumbnailCue,
  buildSourceChain,
  cueAt,
  formatTime,
  isFinished,
  parseThumbnailVtt,
  playCountThreshold,
  qualityOptions,
  resumePosition,
} from './player.utils';

/** Save progress to Stash this often while playing. */
const SAVE_INTERVAL_MS = 15_000;
/** Hide the controls after this long without interaction while playing. */
const CONTROLS_HIDE_MS = 3_000;
/** Volume is remembered across scenes, on this device. */
const VOLUME_KEY = 'stashboard.player.volume';
/** Press and hold on the picture this long to play at 2× until you let go. */
const HOLD_MS = 450;
/** Seconds the Up next card waits before playing the next scene. */
const UP_NEXT_SECONDS = 8;
/** The tag used for the last chapter you added, offered again next time. */
const LAST_MARKER_TAG_KEY = 'stashboard.lastMarkerTag';

interface WebKitVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
  webkitShowPlaybackTargetPicker?: () => void;
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture' | 'fullscreen') => void;
}

@Component({
  selector: 'app-watch-page',
  templateUrl: './watch-page.component.html',
  styleUrl: './watch-page.component.scss',
  host: {
    '[class.controls-hidden]': '!controlsVisible()',
  },
})
export class WatchPageComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly playback = inject(PlaybackService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly appLock = inject(AppLockService);
  private readonly library = inject(LocalLibraryService);

  @ViewChild('video') private videoRef?: ElementRef<WebKitVideo>;
  @ViewChild('shell') private shellRef?: ElementRef<HTMLElement>;
  @ViewChild('seekBar') private seekBarRef?: ElementRef<HTMLElement>;

  protected readonly info = signal<PlaybackInfo | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly playing = signal(false);
  protected readonly buffering = signal(false);
  protected readonly currentTime = signal(0);
  protected readonly duration = signal(0);
  protected readonly bufferedEnd = signal(0);
  protected readonly muted = signal(false);
  protected readonly controlsVisible = signal(true);
  protected readonly qualityMenuOpen = signal(false);
  protected readonly activeQualityId = signal<string | null>(null);
  protected readonly qualities = signal<QualityOption[]>([]);
  protected readonly resumedFrom = signal<number | null>(null);
  protected readonly fullscreen = signal(false);
  protected readonly pipAvailable = signal(false);
  protected readonly airplayAvailable = signal(false);
  protected readonly castAvailable = signal(false);
  protected readonly skipFlash = signal<'back' | 'forward' | null>(null);
  /** A short note over the picture: "Volume 60%", "1.5×", the chapter you jumped to. */
  protected readonly hud = signal<string | null>(null);
  protected readonly speed = signal(1);
  protected readonly volume = signal(1);
  protected readonly speedMenuOpen = signal(false);
  protected readonly helpOpen = signal(false);
  /** Playing at 2× while you hold the picture. */
  protected readonly holding = signal(false);
  protected readonly speeds = SPEEDS;
  protected readonly shortcuts = PLAYER_SHORTCUTS;
  protected readonly speedLabel = speedLabel;
  protected readonly scrub = signal<{
    time: number;
    left: number;
    cue: ThumbnailCue | null;
  } | null>(null);

  protected readonly chaptersMenuOpen = signal(false);
  /** "Add chapter" sheet: title, tag (Stash needs one) and the time it was opened at. */
  protected readonly chapterDraft = signal<{
    seconds: number;
    title: string;
    tag: { id: string; name: string } | null;
  } | null>(null);
  protected readonly chapterTagResults = signal<Array<{ id: string; name: string }>>([]);
  protected readonly chapterSaving = signal(false);
  protected readonly chapterError = signal<string | null>(null);
  /** Shown when the scene ends: the next related scene, with a countdown. */
  protected readonly upNext = signal<LocalSceneCard | null>(null);
  protected readonly upNextCountdown = signal(UP_NEXT_SECONDS);
  protected readonly markers = computed<SceneMarker[]>(() => this.info()?.markers ?? []);
  protected readonly chapterTicks = computed(() => {
    const duration = this.duration();
    return duration > 0
      ? this.markers()
          .filter((marker) => marker.seconds > 0 && marker.seconds < duration)
          .map((marker) => ({ id: marker.id, left: (marker.seconds / duration) * 100 }))
      : [];
  });
  protected readonly currentChapter = computed(() => this.chapterAt(this.currentTime()));

  protected readonly progressPercent = computed(() =>
    this.duration() > 0 ? (this.currentTime() / this.duration()) * 100 : 0,
  );
  protected readonly bufferedPercent = computed(() =>
    this.duration() > 0 ? (this.bufferedEnd() / this.duration()) * 100 : 0,
  );
  protected readonly formatTime = formatTime;

  private sceneId = '';
  private chain: PlaybackCandidate[] = [];
  private chainIndex = 0;
  private hls: Hls | null = null;
  private thumbnails: ThumbnailCue[] = [];
  private pendingSeek: number | null = null;
  private firstLoad = true;
  private watchedSinceSave = 0;
  private watchedTotal = 0;
  private lastTickTime: number | null = null;
  private playCounted = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Removes the "refresh links at the next pause" listener, when one is waiting. */
  private cancelPauseRefresh: (() => void) | null = null;
  /** Bumped whenever a new source starts, so an older, slower start stands down. */
  private sourceAttempt = 0;
  /** Set once the page is gone: late answers and timers must not start playback. */
  private destroyed = false;
  private lastTap = 0;
  private hudTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private speedBeforeHold = 1;
  /** The click that ends a hold isn't also a tap. */
  private suppressTap = false;
  private scrubbing = false;
  private readonly cleanup: Array<() => void> = [];
  private nextCandidate: LocalSceneCard | null = null;
  private upNextTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // App Lock: stop playback (and its sound) while the lock screen is up.
    effect(() => {
      if (this.appLock.locked()) {
        this.videoRef?.nativeElement.pause();
      }
    });
  }

  ngAfterViewInit(): void {
    this.sceneId = this.route.snapshot.paramMap.get('sceneId') ?? '';
    void this.appLock.refresh();
    this.attachVideoListeners();
    this.attachPageLifecycle();
    this.load(null);
    // Up next opens /watch/<other id>; the router reuses this page, so switch in place.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const next = params.get('sceneId') ?? '';
      if (next && next !== this.sceneId) {
        this.switchScene(next);
      }
    });
  }

  private switchScene(sceneId: string): void {
    this.saveProgress('exit');
    this.cancelUpNext();
    this.clearTimer(this.refreshTimer);
    this.cancelPauseRefresh?.();
    this.destroyHls();
    this.sceneId = sceneId;
    this.chain = [];
    this.chainIndex = 0;
    this.thumbnails = [];
    this.pendingSeek = null;
    this.firstLoad = true;
    this.watchedSinceSave = 0;
    this.watchedTotal = 0;
    this.lastTickTime = null;
    this.playCounted = false;
    this.nextCandidate = null;
    this.info.set(null);
    this.currentTime.set(0);
    this.duration.set(0);
    this.bufferedEnd.set(0);
    this.resumedFrom.set(null);
    this.chaptersMenuOpen.set(false);
    this.load(null);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.sourceAttempt += 1;
    this.cancelPauseRefresh?.();
    this.cancelUpNext();
    this.saveProgress('exit');
    this.stopSaveTimer();
    this.clearTimer(this.hideTimer);
    this.clearTimer(this.refreshTimer);
    this.destroyHls();
    this.cleanup.forEach((dispose) => dispose());
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
    }
    this.unlockOrientation();
  }

  // ---------- Loading and sources ----------

  /** Loads (or reloads, keeping `keepTime`) playback info and starts the best source. */
  private load(keepTime: number | null): void {
    this.loading.set(true);
    this.error.set(null);
    const sceneId = this.sceneId;
    if (keepTime === null) {
      // Pick the Up next scene early so it's ready when this one ends.
      this.library
        .related(sceneId)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (items) => {
            if (this.sceneId === sceneId) {
              this.nextCandidate = items.find((item) => item.id !== sceneId) ?? null;
            }
          },
          error: () => undefined,
        });
    }
    this.playback
      .getInfo(sceneId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) => {
          // Another scene opened while this one was loading.
          if (this.sceneId !== sceneId) {
            return;
          }
          this.info.set(info);
          if (info.duration) {
            this.duration.set(info.duration);
          }
          const env = this.environment();
          this.chain = buildSourceChain(info, env);
          this.qualities.set(qualityOptions(info, env));
          this.chainIndex = 0;
          this.setupMediaSession(info);
          this.scheduleLinkRefresh(info.expiresAt);
          void this.loadThumbnails(info.thumbnailsVttUrl);

          if (this.chain.length === 0) {
            this.loading.set(false);
            this.error.set('No playable stream was found for this scene.');
            return;
          }

          // ?t=<seconds> picks the start point (t=0 is "play from the beginning").
          const requested = this.firstLoad ? this.requestedStart() : null;
          const start =
            keepTime ??
            requested ??
            (this.firstLoad ? resumePosition(info.resumeTime, info.duration) : null);
          if (this.firstLoad && start !== null && keepTime === null && requested === null) {
            this.resumedFrom.set(start);
            setTimeout(() => this.resumedFrom.set(null), 6000);
          }
          this.firstLoad = false;
          this.startCandidate(this.chain[0], start, true);
        },
        error: (error: { status?: number; error?: { message?: string } }) => {
          if (this.sceneId !== sceneId) {
            return;
          }
          this.loading.set(false);
          this.error.set(
            error?.error?.message ??
              (error?.status === 404
                ? 'That scene is not in your Stash library.'
                : 'The player could not load this scene.'),
          );
        },
      });
  }

  private environment(): PlayerEnvironment {
    const probe = document.createElement('video');
    return {
      canPlayType: (type) => probe.canPlayType(type),
      hlsJsSupported: typeof window !== 'undefined' && 'MediaSource' in window,
    };
  }

  private async startCandidate(
    candidate: PlaybackCandidate,
    startAt: number | null,
    autoplay: boolean,
  ): Promise<void> {
    const video = this.videoRef?.nativeElement;
    if (!video || this.destroyed) {
      return;
    }
    const attempt = ++this.sourceAttempt;

    this.destroyHls();
    this.pendingSeek = startAt;
    this.activeQualityId.set(this.qualityIdFor(candidate));
    this.loading.set(true);

    if (candidate.engine === 'hls.js') {
      try {
        const { default: HlsClass } = await import('hls.js');
        if (attempt !== this.sourceAttempt) {
          // The page closed, or another source started, while hls.js loaded.
          return;
        }
        const hls = new HlsClass({ startPosition: startAt ?? -1, maxBufferLength: 30 });
        hls.on(HlsClass.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            this.tryNextSource();
          }
        });
        hls.loadSource(candidate.source.url);
        hls.attachMedia(video);
        this.hls = hls;
      } catch {
        this.tryNextSource();
        return;
      }
    } else {
      video.src = candidate.source.url;
      video.load();
    }

    if (autoplay) {
      video.play().catch(() => {
        // Autoplay with sound can be blocked; the user taps play instead.
        this.loading.set(false);
        this.showControls();
      });
    }
  }

  private tryNextSource(): void {
    const video = this.videoRef?.nativeElement;
    const position = video && video.currentTime > 0 ? video.currentTime : this.pendingSeek;
    this.chainIndex += 1;
    const next = this.chain[this.chainIndex];
    if (!next) {
      this.loading.set(false);
      this.error.set(
        "This video couldn't be played here, even after converting it. Try opening it in Stash.",
      );
      return;
    }
    void this.startCandidate(next, position ?? null, true);
  }

  private qualityIdFor(candidate: PlaybackCandidate): string {
    return candidate.source.kind === 'direct'
      ? 'direct'
      : `${candidate.source.kind}-${candidate.source.resolution ?? 'ORIGINAL'}`;
  }

  protected chooseQuality(option: QualityOption): void {
    this.qualityMenuOpen.set(false);
    if (option.id === this.activeQualityId()) {
      return;
    }
    const video = this.videoRef?.nativeElement;
    const position = video?.currentTime ?? 0;
    const wasPlaying = !!video && !video.paused;
    // Picking a quality restarts the fallback chain from that choice.
    this.chain = [option.candidate, ...this.chain.filter((c) => c !== option.candidate)];
    this.chainIndex = 0;
    void this.startCandidate(option.candidate, position, wasPlaying);
  }

  /** Signed links expire; refresh them a few minutes early without interrupting playback. */
  private scheduleLinkRefresh(expiresAt: number): void {
    this.clearTimer(this.refreshTimer);
    this.cancelPauseRefresh?.();
    if (this.destroyed) {
      return;
    }
    const delay = Math.max(60_000, expiresAt * 1000 - Date.now() - 5 * 60_000);
    this.refreshTimer = setTimeout(() => {
      const video = this.videoRef?.nativeElement;
      if (video && !video.paused) {
        // While playing, buffered data keeps going; refresh at the next pause.
        const onPause = () => {
          this.cancelPauseRefresh?.();
          this.load(video.currentTime);
        };
        video.addEventListener('pause', onPause);
        this.cancelPauseRefresh = () => {
          video.removeEventListener('pause', onPause);
          this.cancelPauseRefresh = null;
        };
      } else {
        this.load(video?.currentTime ?? null);
      }
    }, delay);
  }

  private async loadThumbnails(url: string | null): Promise<void> {
    this.thumbnails = [];
    if (!url) {
      return;
    }
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (response.ok) {
        this.thumbnails = parseThumbnailVtt(await response.text(), url);
      }
    } catch {
      // Scrub previews are optional.
    }
  }

  // ---------- Video events, progress and play counts ----------

  private attachVideoListeners(): void {
    const video = this.videoRef?.nativeElement;
    if (!video) {
      return;
    }

    const on = <K extends keyof HTMLVideoElementEventMap>(
      type: K,
      handler: (event: HTMLVideoElementEventMap[K]) => void,
    ) => {
      video.addEventListener(type, handler);
      this.cleanup.push(() => video.removeEventListener(type, handler));
    };

    on('loadedmetadata', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        this.duration.set(video.duration);
      }
      if (this.pendingSeek !== null && !this.hls) {
        video.currentTime = this.pendingSeek;
      }
      this.pendingSeek = null;
    });
    on('playing', () => {
      this.loading.set(false);
      this.buffering.set(false);
      this.playing.set(true);
      this.lastTickTime = video.currentTime;
      this.startSaveTimer();
      this.scheduleHideControls();
      this.updatePositionState();
    });
    on('pause', () => {
      this.playing.set(false);
      this.lastTickTime = null;
      this.stopSaveTimer();
      this.saveProgress('pause');
      this.showControls();
    });
    on('waiting', () => this.buffering.set(true));
    on('canplay', () => {
      this.loading.set(false);
      this.buffering.set(false);
    });
    on('timeupdate', () => {
      this.currentTime.set(video.currentTime);
      this.trackWatched(video.currentTime);
    });
    on('progress', () => {
      const ranges = video.buffered;
      this.bufferedEnd.set(ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
    });
    video.volume = readVolume();
    on('volumechange', () => {
      this.muted.set(video.muted);
      this.volume.set(video.volume);
    });
    on('ratechange', () => {
      if (!this.holding()) {
        this.speed.set(video.playbackRate);
      }
    });
    on('ended', () => {
      this.playing.set(false);
      this.saveProgress('ended');
      this.showControls();
      this.startUpNext();
    });
    on('play', () => this.cancelUpNext());
    on('error', () => {
      // Native playback failed (unsupported codec, missing audio track…): fall back.
      if (!this.hls) {
        this.tryNextSource();
      }
    });

    // Picture-in-picture and casting availability.
    this.pipAvailable.set(
      ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) ||
        typeof video.webkitSetPresentationMode === 'function',
    );
    if ('WebKitPlaybackTargetAvailabilityEvent' in window) {
      const onAirplay = (event: Event) =>
        this.airplayAvailable.set(
          (event as Event & { availability?: string }).availability === 'available',
        );
      video.addEventListener('webkitplaybacktargetavailabilitychanged', onAirplay);
      this.cleanup.push(() =>
        video.removeEventListener('webkitplaybacktargetavailabilitychanged', onAirplay),
      );
    }
    if (video.remote) {
      video.remote
        .watchAvailability((available) => this.castAvailable.set(available))
        .catch(() => {
          this.castAvailable.set(false);
        });
    }
  }

  /** Counts real watching time (not seeking) toward progress and play counts. */
  private trackWatched(position: number): void {
    if (this.lastTickTime !== null && this.playing()) {
      const delta = position - this.lastTickTime;
      if (delta > 0 && delta < 2) {
        this.watchedSinceSave += delta;
        this.watchedTotal += delta;
      }
    }
    this.lastTickTime = position;

    if (!this.playCounted && this.watchedTotal >= playCountThreshold(this.duration() || null)) {
      this.playCounted = true;
      this.playback.addPlay(this.sceneId).subscribe({ error: () => undefined });
    }
  }

  private saveProgress(reason: 'tick' | 'pause' | 'ended' | 'exit'): void {
    const video = this.videoRef?.nativeElement;
    if (!video || !this.sceneId || !this.info()) {
      return;
    }
    const position =
      reason === 'ended' || isFinished(video.currentTime, this.duration() || null)
        ? 0
        : video.currentTime;
    const watched = Math.round(this.watchedSinceSave * 10) / 10;
    if (watched <= 0 && reason === 'tick') {
      return;
    }
    this.watchedSinceSave = 0;

    if (reason === 'exit') {
      this.playback.saveActivityOnExit(this.sceneId, position, watched);
    } else {
      this.playback
        .saveActivity(this.sceneId, position, watched)
        .subscribe({ error: () => undefined });
    }
  }

  private startSaveTimer(): void {
    this.stopSaveTimer();
    this.saveTimer = setInterval(() => this.saveProgress('tick'), SAVE_INTERVAL_MS);
  }

  private stopSaveTimer(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** Installed apps are often closed or backgrounded without warning: save then. */
  private attachPageLifecycle(): void {
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        this.saveProgress('exit');
      }
    };
    const onPageHide = () => this.saveProgress('exit');
    const onFullscreen = () => {
      const active = !!document.fullscreenElement;
      this.fullscreen.set(active);
      if (!active) {
        this.unlockOrientation();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('fullscreenchange', onFullscreen);
    this.cleanup.push(() => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('fullscreenchange', onFullscreen);
    });
  }

  // ---------- Lock screen / media keys ----------

  private setupMediaSession(info: PlaybackInfo): void {
    if (!('mediaSession' in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title: info.title,
      artist: info.studio ?? 'Stashboard',
      artwork: info.posterUrl
        ? [
            {
              src: new URL(info.posterUrl, window.location.origin).toString(),
              sizes: '640x448',
              type: 'image/jpeg',
            },
          ]
        : [],
    });
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not every browser supports every action.
      }
    };
    set('play', () => {
      // Headphone buttons and the lock screen must not play behind App Lock.
      if (!this.appLock.locked()) {
        void this.videoRef?.nativeElement.play();
      }
    });
    set('pause', () => this.videoRef?.nativeElement.pause());
    set('seekbackward', (details) => this.skip(-(details.seekOffset ?? SKIP_SECONDS)));
    set('seekforward', (details) => this.skip(details.seekOffset ?? SKIP_SECONDS));
    set('seekto', (details) => {
      if (details.seekTime !== undefined) {
        this.seekTo(details.seekTime);
      }
    });
  }

  private updatePositionState(): void {
    const video = this.videoRef?.nativeElement;
    if (!video || !('mediaSession' in navigator) || !Number.isFinite(video.duration)) {
      return;
    }
    try {
      navigator.mediaSession.setPositionState({
        duration: video.duration,
        position: Math.min(video.currentTime, video.duration),
        playbackRate: video.playbackRate,
      });
    } catch {
      // ignore
    }
  }

  // ---------- Controls ----------

  protected togglePlay(): void {
    const video = this.videoRef?.nativeElement;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }

  protected skip(seconds: number): void {
    const video = this.videoRef?.nativeElement;
    if (!video) {
      return;
    }
    this.seekTo(video.currentTime + seconds);
    this.skipFlash.set(seconds < 0 ? 'back' : 'forward');
    setTimeout(() => this.skipFlash.set(null), 450);
  }

  protected seekTo(time: number): void {
    const video = this.videoRef?.nativeElement;
    if (!video) {
      return;
    }
    const max = this.duration() || video.duration || 0;
    video.currentTime = Math.max(0, Math.min(max > 1 ? max - 0.5 : time, time));
    this.currentTime.set(video.currentTime);
    this.lastTickTime = video.currentTime;
    this.updatePositionState();
    this.showControls();
  }

  private requestedStart(): number | null {
    const raw = this.route.snapshot.queryParamMap.get('t');
    if (raw === null || raw.trim() === '') {
      return null;
    }
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  protected startOver(): void {
    this.resumedFrom.set(null);
    this.seekTo(0);
  }

  protected toggleMute(): void {
    const video = this.videoRef?.nativeElement;
    if (video) {
      video.muted = !video.muted;
    }
  }

  protected changeVolume(delta: number): void {
    const video = this.videoRef?.nativeElement;
    if (!video) {
      return;
    }
    const next = Math.round(Math.max(0, Math.min(1, video.volume + delta)) * 100) / 100;
    video.volume = next;
    video.muted = next === 0;
    writeVolume(next);
    this.showHud(next === 0 ? 'Muted' : `Volume ${Math.round(next * 100)}%`);
  }

  protected setSpeed(rate: number): void {
    const video = this.videoRef?.nativeElement;
    this.speedMenuOpen.set(false);
    if (!video) {
      return;
    }
    video.playbackRate = rate;
    this.speed.set(rate);
    this.showHud(speedLabel(rate));
  }

  protected toggleSpeedMenu(): void {
    this.speedMenuOpen.update((open) => !open);
    this.qualityMenuOpen.set(false);
    this.chaptersMenuOpen.set(false);
    this.showControls();
  }

  /** One frame back or forward; pauses first, as stepping only makes sense paused. */
  private stepFrame(direction: -1 | 1): void {
    const video = this.videoRef?.nativeElement;
    if (!video) {
      return;
    }
    video.pause();
    this.seekTo(video.currentTime + direction * FRAME_SECONDS);
  }

  /** The previous or next chapter; "previous" restarts this one if you're past its start. */
  private stepChapter(direction: -1 | 1): void {
    const video = this.videoRef?.nativeElement;
    const markers = [...this.markers()].sort((a, b) => a.seconds - b.seconds);
    if (!video || markers.length === 0) {
      this.showHud('No chapters');
      return;
    }
    const now = video.currentTime;
    const target =
      direction === 1
        ? markers.find((marker) => marker.seconds > now + 0.5)
        : [...markers].reverse().find((marker) => marker.seconds < now - 2);
    if (!target) {
      if (direction === -1) {
        this.seekTo(0);
        this.showHud('Start');
      }
      return;
    }
    this.seekTo(target.seconds);
    this.showHud(target.title);
  }

  private showHud(text: string): void {
    this.hud.set(text);
    this.clearTimer(this.hudTimer);
    this.hudTimer = setTimeout(() => this.hud.set(null), 900);
  }

  protected async toggleFullscreen(): Promise<void> {
    const shell = this.shellRef?.nativeElement;
    const video = this.videoRef?.nativeElement;
    if (!shell || !video) {
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (typeof shell.requestFullscreen === 'function') {
      await shell.requestFullscreen().catch(() => undefined);
      this.lockLandscapeIfWide(video);
    } else if (typeof video.webkitEnterFullscreen === 'function') {
      // iPhone: only the video element can go fullscreen.
      video.webkitEnterFullscreen();
    }
  }

  private lockLandscapeIfWide(video: HTMLVideoElement): void {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>;
    };
    if (video.videoWidth > video.videoHeight && typeof orientation?.lock === 'function') {
      orientation.lock('landscape').catch(() => undefined);
    }
  }

  private unlockOrientation(): void {
    try {
      screen.orientation?.unlock?.();
    } catch {
      // ignore
    }
  }

  protected async togglePip(): Promise<void> {
    const video = this.videoRef?.nativeElement;
    if (!video) {
      return;
    }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture().catch(() => undefined);
    } else if (typeof video.requestPictureInPicture === 'function') {
      await video.requestPictureInPicture().catch(() => undefined);
    } else if (typeof video.webkitSetPresentationMode === 'function') {
      video.webkitSetPresentationMode('picture-in-picture');
    }
  }

  protected showAirplay(): void {
    this.videoRef?.nativeElement.webkitShowPlaybackTargetPicker?.();
  }

  protected async cast(): Promise<void> {
    const video = this.videoRef?.nativeElement;
    if (!video?.remote) {
      return;
    }
    // TVs fetch the stream themselves, which only works with a plain URL (not hls.js).
    if (this.hls) {
      const plain = this.chain.find((c) => c.engine === 'native');
      if (plain) {
        await this.startCandidate(plain, video.currentTime, false);
      }
    }
    await video.remote.prompt().catch(() => undefined);
  }

  protected toggleQualityMenu(): void {
    this.qualityMenuOpen.update((open) => !open);
    this.speedMenuOpen.set(false);
    this.showControls();
  }

  // ---------- Chapters and Up next ----------

  protected chapterAt(time: number): SceneMarker | null {
    let current: SceneMarker | null = null;
    for (const marker of this.markers()) {
      if (marker.seconds <= time + 0.25) {
        current = marker;
      } else {
        break;
      }
    }
    return current;
  }

  protected toggleChaptersMenu(): void {
    this.chaptersMenuOpen.update((open) => !open);
    this.qualityMenuOpen.set(false);
    this.speedMenuOpen.set(false);
    this.showControls();
  }

  protected jumpToChapter(marker: SceneMarker): void {
    this.chaptersMenuOpen.set(false);
    this.seekTo(marker.seconds);
    void this.videoRef?.nativeElement.play().catch(() => undefined);
  }

  protected openChapterDraft(): void {
    const video = this.videoRef?.nativeElement;
    video?.pause();
    this.chaptersMenuOpen.set(false);
    this.chapterError.set(null);
    this.chapterTagResults.set([]);
    this.chapterDraft.set({
      seconds: Math.floor(video?.currentTime ?? this.currentTime()),
      title: '',
      tag: readLastMarkerTag(),
    });
  }

  protected closeChapterDraft(): void {
    this.chapterDraft.set(null);
  }

  protected setChapterTitle(title: string): void {
    this.chapterDraft.update((draft) => (draft ? { ...draft, title } : draft));
  }

  protected searchChapterTags(query: string): void {
    const value = query.trim();
    if (!value) {
      this.chapterTagResults.set([]);
      return;
    }
    this.library.searchTags(value).subscribe({
      next: (tags) => this.chapterTagResults.set(tags.slice(0, 6)),
      error: () => this.chapterTagResults.set([]),
    });
  }

  protected pickChapterTag(tag: { id: string; name: string }): void {
    this.chapterDraft.update((draft) => (draft ? { ...draft, tag } : draft));
    this.chapterTagResults.set([]);
  }

  protected clearChapterTag(): void {
    this.chapterDraft.update((draft) => (draft ? { ...draft, tag: null } : draft));
  }

  protected saveChapter(): void {
    const draft = this.chapterDraft();
    if (!draft || !draft.tag || this.chapterSaving()) {
      return;
    }
    this.chapterSaving.set(true);
    this.chapterError.set(null);
    this.library
      .addMarker(this.sceneId, {
        title: draft.title.trim() || draft.tag.name,
        seconds: draft.seconds,
        primaryTagId: draft.tag.id,
      })
      .subscribe({
        next: (scene) => {
          writeLastMarkerTag(draft.tag);
          this.applyMarkers(scene.markers ?? []);
          this.chapterSaving.set(false);
          this.chapterDraft.set(null);
        },
        error: () => {
          this.chapterSaving.set(false);
          this.chapterError.set("Couldn't save the chapter to Stash. Try again.");
        },
      });
  }

  protected deleteChapter(marker: SceneMarker, event: Event): void {
    event.stopPropagation();
    if (!window.confirm(`Delete the chapter "${marker.title}"?`)) {
      return;
    }
    this.library.deleteMarker(this.sceneId, marker.id).subscribe({
      next: (scene) => this.applyMarkers(scene.markers ?? []),
      error: () => undefined,
    });
  }

  private applyMarkers(markers: SceneMarker[]): void {
    const info = this.info();
    if (info) {
      this.info.set({ ...info, markers });
    }
  }

  private startUpNext(): void {
    const next = this.nextCandidate;
    if (!next || this.upNext()) {
      return;
    }
    this.upNext.set(next);
    this.upNextCountdown.set(UP_NEXT_SECONDS);
    this.upNextTimer = setInterval(() => {
      const remaining = this.upNextCountdown() - 1;
      if (remaining <= 0) {
        this.playUpNext();
      } else {
        this.upNextCountdown.set(remaining);
      }
    }, 1000);
  }

  protected cancelUpNext(): void {
    if (this.upNextTimer) {
      clearInterval(this.upNextTimer);
      this.upNextTimer = null;
    }
    this.upNext.set(null);
  }

  protected playUpNext(): void {
    const next = this.upNext() ?? this.nextCandidate;
    this.cancelUpNext();
    if (!next) {
      return;
    }
    const returnTo = this.route.snapshot.queryParamMap.get('returnTo');
    void this.router.navigate(['/watch', next.id], {
      queryParams: returnTo ? { returnTo } : {},
      replaceUrl: true,
    });
  }

  protected goBack(): void {
    const returnTo = this.route.snapshot.queryParamMap.get('returnTo');
    // Only paths inside the app ("/library"), not "//host" or "/\host".
    if (returnTo && /^\/(?![/\\])/.test(returnTo)) {
      void this.router.navigateByUrl(returnTo);
    } else if (window.history.length > 1) {
      window.history.back();
    } else {
      // Opened directly (e.g. from the installed app): go Home.
      void this.router.navigateByUrl('/home');
    }
  }

  protected openInStash(): void {
    const url = this.info()?.viewUrl;
    if (url) {
      window.open(url, '_blank', 'noopener');
    }
  }

  /**
   * Mouse: click plays/pauses, double-click toggles fullscreen.
   * Touch: tap shows/hides controls, double-tap on the left or right third skips.
   */
  protected onSurfaceDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    this.clearTimer(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      const video = this.videoRef?.nativeElement;
      if (!video || video.paused) {
        return;
      }
      this.speedBeforeHold = video.playbackRate;
      this.holding.set(true);
      this.suppressTap = true;
      video.playbackRate = 2;
    }, HOLD_MS);
  }

  protected onSurfaceUp(): void {
    this.clearTimer(this.holdTimer);
    this.holdTimer = null;
    if (!this.holding()) {
      return;
    }
    const video = this.videoRef?.nativeElement;
    if (video) {
      video.playbackRate = this.speedBeforeHold;
    }
    this.holding.set(false);
  }

  protected onSurfaceTap(event: PointerEvent): void {
    if (this.suppressTap) {
      this.suppressTap = false;
      return;
    }
    const now = Date.now();
    const isDoubleTap = now - this.lastTap < 300;
    this.lastTap = now;

    if (event.pointerType === 'mouse') {
      if (isDoubleTap) {
        void this.toggleFullscreen();
      } else {
        this.togglePlay();
      }
      return;
    }

    const shell = this.shellRef?.nativeElement;
    if (isDoubleTap && shell) {
      const ratio = event.clientX / shell.clientWidth;
      if (ratio < 0.35 || ratio > 0.65) {
        this.skip(ratio < 0.35 ? -SKIP_SECONDS : SKIP_SECONDS);
        return;
      }
    }

    if (this.controlsVisible() && this.playing()) {
      this.controlsVisible.set(false);
    } else {
      this.showControls();
    }
  }

  protected showControls(): void {
    this.controlsVisible.set(true);
    this.scheduleHideControls();
  }

  private scheduleHideControls(): void {
    this.clearTimer(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.playing() && !this.qualityMenuOpen() && !this.speedMenuOpen() && !this.scrubbing) {
        this.controlsVisible.set(false);
      }
    }, CONTROLS_HIDE_MS);
  }

  // ---------- Seek bar with scrub previews ----------

  private timeAtPointer(clientX: number): { time: number; left: number } | null {
    const bar = this.seekBarRef?.nativeElement;
    const duration = this.duration();
    if (!bar || !duration) {
      return null;
    }
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return { time: ratio * duration, left: ratio * 100 };
  }

  protected onSeekHover(event: PointerEvent): void {
    const point = this.timeAtPointer(event.clientX);
    if (!point) {
      return;
    }
    this.scrub.set({
      ...point,
      cue: this.thumbnails.length ? cueAt(this.thumbnails, point.time) : null,
    });
    if (this.scrubbing) {
      this.currentTime.set(point.time);
    }
  }

  protected onSeekDown(event: PointerEvent): void {
    this.scrubbing = true;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.onSeekHover(event);
    this.showControls();
  }

  protected onSeekUp(event: PointerEvent): void {
    const point = this.timeAtPointer(event.clientX);
    this.scrubbing = false;
    this.scrub.set(null);
    if (point) {
      this.seekTo(point.time);
    }
  }

  protected onSeekLeave(): void {
    if (!this.scrubbing) {
      this.scrub.set(null);
    }
  }

  protected onSeekKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      this.skip(event.key === 'ArrowLeft' ? -5 : 5);
    }
  }

  protected scrubThumbStyle(cue: ThumbnailCue): Record<string, string> {
    return {
      width: `${cue.width}px`,
      height: `${cue.height}px`,
      'background-image': `url("${cue.url}")`,
      'background-position': `-${cue.x}px -${cue.y}px`,
    };
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    // While App Lock is up, keys belong to the lock screen, not the player.
    if (this.appLock.locked()) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
      return;
    }
    const action = playerKeyAction(event);
    if (!action) {
      return;
    }
    if (this.helpOpen() && action.type !== 'help') {
      // The list is up: any key closes it, and Esc does nothing else.
      this.helpOpen.set(false);
      if (action.type === 'escape') {
        return;
      }
    }
    switch (action.type) {
      case 'toggle-play':
        event.preventDefault();
        this.togglePlay();
        break;
      case 'skip':
        event.preventDefault();
        this.skip(action.seconds);
        break;
      case 'volume':
        event.preventDefault();
        this.changeVolume(action.delta);
        break;
      case 'seek-percent': {
        const duration = this.duration();
        if (duration > 0) {
          this.seekTo((duration * action.percent) / 100);
          this.showHud(`${action.percent}%`);
        }
        break;
      }
      case 'frame':
        this.stepFrame(action.direction);
        break;
      case 'speed':
        this.setSpeed(stepSpeed(this.speed(), action.direction));
        break;
      case 'chapter':
        this.stepChapter(action.direction);
        break;
      case 'next':
        if (this.upNext() || this.nextCandidate) {
          this.playUpNext();
        } else {
          this.showHud('Nothing up next');
        }
        break;
      case 'fullscreen':
        void this.toggleFullscreen();
        break;
      case 'mute':
        this.toggleMute();
        break;
      case 'pip':
        if (this.pipAvailable()) {
          void this.togglePip();
        }
        break;
      case 'help':
        this.helpOpen.update((open) => !open);
        break;
      case 'escape':
        if (this.speedMenuOpen() || this.qualityMenuOpen() || this.chaptersMenuOpen()) {
          this.speedMenuOpen.set(false);
          this.qualityMenuOpen.set(false);
          this.chaptersMenuOpen.set(false);
        } else if (!document.fullscreenElement) {
          this.goBack();
        }
        break;
    }
    this.showControls();
  }

  @HostListener('pointermove')
  protected onPointerMove(): void {
    this.showControls();
  }

  private destroyHls(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function readLastMarkerTag(): { id: string; name: string } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_MARKER_TAG_KEY) ?? 'null') as unknown;
    const tag = parsed as { id?: unknown; name?: unknown } | null;
    return tag && typeof tag.id === 'string' && typeof tag.name === 'string'
      ? { id: tag.id, name: tag.name }
      : null;
  } catch {
    return null;
  }
}

function writeLastMarkerTag(tag: { id: string; name: string } | null): void {
  try {
    localStorage.setItem(LAST_MARKER_TAG_KEY, JSON.stringify(tag));
  } catch {
    // ignore
  }
}

function readVolume(): number {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && value >= 0 && value <= 1 ? value : 1;
  } catch {
    return 1;
  }
}

function writeVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // ignore
  }
}
