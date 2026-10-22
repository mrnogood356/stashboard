import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  QueryList,
  ViewChild,
  ViewChildren,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LocalLibraryService, LocalSceneCard } from '../../core/api/local-library.service';
import { AppLockService } from '../../core/app-lock/app-lock.service';

const SOUND_KEY = 'stashboard.feedSound';

/**
 * A full-screen, swipe-up feed of preview clips from your library, in random
 * order. Only the clip on screen plays; tap Play to watch the whole scene.
 */
@Component({
  selector: 'app-feed-page',
  imports: [RouterLink],
  templateUrl: './feed-page.component.html',
  styleUrl: './feed-page.component.scss',
})
export class FeedPageComponent implements AfterViewInit, OnDestroy {
  private readonly library = inject(LocalLibraryService);
  private readonly router = inject(Router);
  private readonly appLock = inject(AppLockService);
  private observer: IntersectionObserver | null = null;
  private readonly seed = Math.floor(Math.random() * 2_000_000_000) + 1;
  private page = 0;
  private hasMore = true;

  @ViewChild('track') private trackRef?: ElementRef<HTMLElement>;
  @ViewChildren('slide') private slides?: QueryList<ElementRef<HTMLElement>>;

  protected readonly items = signal<LocalSceneCard[]>([]);
  protected readonly active = signal(0);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sound = signal(readSound());
  /** Scenes whose preview clip failed; they show the picture instead. */
  protected readonly failed = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // The feed is outside the app shell: stop every clip when App Lock comes up.
    effect(() => {
      if (this.appLock.locked()) {
        this.slides?.forEach((slide) => slide.nativeElement.querySelector('video')?.pause());
      }
    });
  }

  ngAfterViewInit(): void {
    // Opened directly (not through the shell), App Lock still needs its status
    // to lock after the timeout.
    void this.appLock.refresh();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            const index = Number((entry.target as HTMLElement).dataset['index']);
            if (!Number.isNaN(index)) {
              this.activate(index);
            }
          }
        }
      },
      { root: this.trackRef?.nativeElement ?? null, threshold: [0.6] },
    );
    this.slides?.changes.subscribe(() => this.observeSlides());
    this.loadMore();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  protected loadMore(): void {
    if (this.loading() || !this.hasMore) {
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.library.feed(this.page + 1, this.seed).subscribe({
      next: (result) => {
        this.page = result.page;
        this.hasMore = result.hasMore;
        this.items.update((items) => [...items, ...result.items]);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set("Couldn't load your library. Check that Stash is running.");
      },
    });
  }

  /** Clips near the one on screen get a video element; the rest stay pictures. */
  protected nearActive(index: number): boolean {
    return Math.abs(index - this.active()) <= 1;
  }

  protected previewUrl(item: LocalSceneCard): string {
    return `/api/playback/scenes/${encodeURIComponent(item.id)}/preview`;
  }

  protected onPreviewError(id: string): void {
    this.failed.update((set) => new Set([...set, id]));
  }

  protected toggleSound(): void {
    const next = !this.sound();
    this.sound.set(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? '1' : '0');
    } catch {
      // ignore
    }
    const video = this.videoAt(this.active());
    if (video) {
      video.muted = !next;
      void video.play().catch(() => undefined);
    }
  }

  protected step(direction: 1 | -1): void {
    const track = this.trackRef?.nativeElement;
    if (track) {
      track.scrollBy({ top: direction * track.clientHeight, behavior: 'smooth' });
    }
  }

  protected close(): void {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      void this.router.navigateByUrl('/home');
    }
  }

  protected formatDuration(seconds: number | null): string | null {
    if (!seconds) {
      return null;
    }
    const minutes = Math.round(seconds / 60);
    return minutes >= 60
      ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
      : `${Math.max(1, minutes)} min`;
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    // While App Lock is up, keys belong to the lock screen.
    if (this.appLock.locked()) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      this.step(1);
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      this.step(-1);
    } else if (event.key === 'm') {
      this.toggleSound();
    } else if (event.key === 'Escape') {
      this.close();
    }
  }

  private activate(index: number): void {
    if (index === this.active() && this.videoAt(index)?.paused === false) {
      return;
    }
    this.active.set(index);
    // Let Angular render the video for the new slide, then play only it.
    setTimeout(() => {
      this.slides?.forEach((slide, slideIndex) => {
        const video = slide.nativeElement.querySelector('video');
        if (!video) {
          return;
        }
        if (slideIndex === index && !this.appLock.locked()) {
          video.muted = !this.sound();
          void video.play().catch(() => {
            // Autoplay with sound was refused; fall back to muted.
            video.muted = true;
            this.sound.set(false);
            void video.play().catch(() => undefined);
          });
        } else {
          video.pause();
        }
      });
    });
    if (index >= this.items().length - 3) {
      this.loadMore();
    }
  }

  private observeSlides(): void {
    if (!this.observer) {
      return;
    }
    this.observer.disconnect();
    this.slides?.forEach((slide) => this.observer?.observe(slide.nativeElement));
  }

  private videoAt(index: number): HTMLVideoElement | null {
    return this.slides?.get(index)?.nativeElement.querySelector('video') ?? null;
  }
}

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}
