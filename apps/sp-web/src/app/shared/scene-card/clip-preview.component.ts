import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ImageObscurationService } from '../../core/preferences/image-obscuration.service';
import { InViewPreviewCard, inViewPreviews } from './in-view-previews';

/** Clips that wouldn't play, kept for the session so they aren't fetched again. */
const failedClips = new Set<string>();

/** For tests. */
export function resetFailedClips(): void {
  failedClips.clear();
}

/**
 * A picture that plays a short silent clip over itself, as Stash's marker
 * cards do: on hover with a mouse, or on a touch screen while it's the one
 * nearest the middle of the screen. Never while images are obscured.
 */
@Component({
  selector: 'app-clip-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-content></ng-content>
    @if (playing() && clip) {
      <video
        class="clip"
        [class.is-playing]="shown()"
        [src]="clip"
        [muted]="true"
        muted
        autoplay
        loop
        playsinline
        disableremoteplayback
        preload="auto"
        aria-hidden="true"
        (loadedmetadata)="start($event)"
        (playing)="shown.set(true)"
        (error)="failed()"
      ></video>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      width: 100%;
      height: 100%;
      -webkit-touch-callout: none;
      -webkit-user-drag: none;
      user-select: none;
    }
    .clip {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      pointer-events: none;
      /* Hides a garbage line along a clip's edge, as on scene cards. */
      transform: scale(1.03);
      opacity: 0;
      transition: opacity 0.25s ease;
    }
    .clip.is-playing {
      opacity: 1;
    }
  `,
  host: {
    '(pointerenter)': 'onEnter($event)',
    '(pointerleave)': 'onLeave($event)',
    '(dragstart)': '$event.preventDefault()',
  },
})
export class ClipPreviewComponent implements AfterViewInit, OnDestroy {
  /** The clip; null shows the picture alone. */
  @Input() clip: string | null = null;

  protected readonly playing = signal(false);
  protected readonly shown = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private inView: InViewPreviewCard | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly obscured = inject(ImageObscurationService).isObscured;

  constructor() {
    // Obscuring images stops a clip that's playing; clearing lets one start again.
    effect(() => {
      if (this.obscured()) {
        this.stop();
      }
      inViewPreviews.refresh();
    });
  }

  ngAfterViewInit(): void {
    if (inViewPreviews.applies()) {
      this.inView = {
        element: this.host.nativeElement,
        canPlay: () => this.canPlay(),
        setActive: (active) => (active && this.canPlay() ? this.playing.set(true) : this.stop()),
      };
      inViewPreviews.register(this.inView);
    }
  }

  ngOnDestroy(): void {
    this.clearHover();
    if (this.inView) {
      inViewPreviews.unregister(this.inView);
    }
  }

  protected onEnter(event: PointerEvent): void {
    if (this.isMouse(event) && this.canPlay()) {
      this.clearHover();
      this.hoverTimer = setTimeout(() => this.playing.set(true), 350);
    }
  }

  protected onLeave(event: PointerEvent): void {
    if (this.isMouse(event)) {
      this.stop();
    }
  }

  /** Angular sets `muted` as an attribute, which doesn't mute; browsers then block autoplay. */
  protected start(event: Event): void {
    const video = event.target as HTMLVideoElement;
    video.muted = true;
    video.play?.()?.catch((error: unknown) => {
      // AbortError: it was stopped before it started, which is fine. Anything
      // else (autoplay blocked, say) won't get better by asking again.
      if ((error as { name?: string } | null)?.name !== 'AbortError') {
        this.failed();
      }
    });
  }

  protected failed(): void {
    if (this.clip) {
      failedClips.add(this.clip);
    }
    this.stop();
    inViewPreviews.refresh();
  }

  private canPlay(): boolean {
    return Boolean(this.clip) && !failedClips.has(this.clip as string) && !this.obscured();
  }

  private isMouse(event: PointerEvent): boolean {
    return event.pointerType === 'mouse' || event.pointerType === 'pen';
  }

  private stop(): void {
    this.clearHover();
    this.playing.set(false);
    this.shown.set(false);
  }

  private clearHover(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }
}
