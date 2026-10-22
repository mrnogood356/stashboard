import {
  Component,
  ContentChild,
  Directive,
  ElementRef,
  Input,
  OnDestroy,
  ViewChild,
  signal,
} from '@angular/core';
import { Params, RouterLink } from '@angular/router';

export interface SceneCardShellItem {
  title: string;
  imageUrl: string | null;
  cardImageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  studioImageUrl: string | null;
}

export type SceneCardShellVariant = 'default' | 'rail';

/**
 * Preview clips Stash has not made (or that would not play). Kept for the
 * session so hovering the card again doesn't fetch it, or flash a black box,
 * every time.
 */
const unavailablePreviews = new Set<string>();

/** For tests. */
export function resetUnavailablePreviews(): void {
  unavailablePreviews.clear();
}

export type SceneCardShellLink =
  | {
      kind: 'router';
      commands: string | readonly unknown[];
      queryParams?: Params | null;
      ariaLabel?: string | null;
    }
  | {
      kind: 'external';
      href: string;
      ariaLabel?: string | null;
    };

@Directive({
  selector: '[sceneCardTopRight]',
  standalone: true,
})
export class SceneCardTopRightDirective {}

@Directive({
  selector: '[sceneCardMediaFooter]',
  standalone: true,
})
export class SceneCardMediaFooterDirective {}

@Directive({
  selector: '[sceneCardBody]',
  standalone: true,
})
export class SceneCardBodyDirective {}

@Directive({
  selector: '[sceneCardPlaceholder]',
  standalone: true,
})
export class SceneCardPlaceholderDirective {}

@Component({
  selector: 'app-scene-card-shell',
  imports: [RouterLink],
  templateUrl: './scene-card-shell.component.html',
  styleUrl: './scene-card-shell.component.scss',
  host: {
    '[class.scene-card-shell-variant-rail]': "variant === 'rail'",
    '[class.scene-card-shell-variant-default]': "variant === 'default'",
  },
})
export class SceneCardShellComponent implements OnDestroy {
  @Input({ required: true }) item!: SceneCardShellItem;
  @Input() variant: SceneCardShellVariant = 'default';
  @Input() primaryLink: SceneCardShellLink | null = null;
  @Input() studioBadgeLink: SceneCardShellLink | null = null;
  /** Route to the built-in player, for scenes that are in the Stash library. */
  @Input() playCommands: readonly unknown[] | null = null;
  @Input() playQueryParams: Params | null = null;
  /** How far through the scene playback got, 0 to 1. */
  @Input() progress: number | null = null;
  /** Stash's short preview clip; plays on hover, or when the card is pressed and held. */
  @Input() previewUrl: string | null = null;

  protected readonly previewing = signal(false);
  /** True once the clip is actually playing; until then the picture stays in front. */
  protected readonly previewPlaying = signal(false);
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Starts the clip in code. Angular adds `muted` as an attribute after the
   * <video> exists, which doesn't mute it, so browsers blocked the autoplay
   * until the user had clicked somewhere on the page. Muting the element
   * itself and calling play() works on the first hover.
   */
  @ViewChild('previewVideo')
  private set previewVideo(ref: ElementRef<HTMLVideoElement> | undefined) {
    const video = ref?.nativeElement;
    if (!video) {
      return;
    }
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    const attempt = typeof video.play === 'function' ? video.play() : undefined;
    attempt?.catch((error: unknown) => {
      // AbortError: the pointer left before it started, which is fine.
      if ((error as { name?: string } | null)?.name !== 'AbortError') {
        this.previewPlaying.set(false);
      }
    });
  }
  /** Set after a press-and-hold, so letting go doesn't also open the scene. */
  protected readonly swallowTap = signal(false);

  ngOnDestroy(): void {
    this.cancelPreviewTimer();
  }

  protected onPointerEnter(event: PointerEvent): void {
    if (this.isHoverPointer(event) && this.canPreview()) {
      this.schedulePreview(450);
    }
  }

  /**
   * Backup for a missed pointerenter: a card that loaded, or scrolled in,
   * under a still pointer only gets moves.
   */
  protected onPointerMove(event: PointerEvent): void {
    if (
      this.isHoverPointer(event) &&
      !this.previewing() &&
      !this.previewTimer &&
      this.canPreview()
    ) {
      this.schedulePreview(450);
    }
  }

  protected onPointerLeave(event: PointerEvent): void {
    if (this.isHoverPointer(event)) {
      this.stopPreview();
    }
  }

  protected onTouchStart(): void {
    if (this.canPreview()) {
      this.swallowTap.set(false);
      this.schedulePreview(380, true);
    }
  }

  protected onTouchMove(): void {
    // Scrolling the page, not holding the card.
    if (!this.previewing()) {
      this.cancelPreviewTimer();
    }
  }

  protected onTouchEnd(): void {
    this.stopPreview();
    if (this.swallowTap()) {
      setTimeout(() => this.swallowTap.set(false), 450);
    }
  }

  protected onPreviewPlaying(): void {
    this.previewPlaying.set(true);
  }

  protected onPreviewError(): void {
    // No preview generated for this scene; keep showing the picture.
    if (this.previewUrl) {
      unavailablePreviews.add(this.previewUrl);
    }
    this.previewing.set(false);
    this.previewPlaying.set(false);
  }

  private canPreview(): boolean {
    return Boolean(this.previewUrl) && !unavailablePreviews.has(this.previewUrl as string);
  }

  /** Mouse or pen; touch uses press-and-hold instead. */
  private isHoverPointer(event: PointerEvent): boolean {
    return event.pointerType === 'mouse' || event.pointerType === 'pen';
  }

  private schedulePreview(delay: number, fromTouch = false): void {
    this.cancelPreviewTimer();
    this.previewTimer = setTimeout(() => {
      this.previewing.set(true);
      if (fromTouch) {
        this.swallowTap.set(true);
        navigator.vibrate?.(10);
      }
    }, delay);
  }

  private stopPreview(): void {
    this.cancelPreviewTimer();
    this.previewing.set(false);
    this.previewPlaying.set(false);
  }

  private cancelPreviewTimer(): void {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

  @ContentChild(SceneCardTopRightDirective)
  private topRightSlot?: SceneCardTopRightDirective;

  @ContentChild(SceneCardMediaFooterDirective)
  private mediaFooterSlot?: SceneCardMediaFooterDirective;

  @ContentChild(SceneCardBodyDirective)
  private bodySlot?: SceneCardBodyDirective;

  protected progressPercent(): number | null {
    return this.progress !== null && this.progress > 0.005
      ? Math.min(100, Math.round(this.progress * 1000) / 10)
      : null;
  }

  protected thumbnailUrl(): string | null {
    return this.item.cardImageUrl ?? this.item.imageUrl;
  }

  protected hasStudioBadge(): boolean {
    return Boolean(this.item.studioImageUrl || this.item.studio);
  }

  protected hasTopRightSlot(): boolean {
    return Boolean(this.topRightSlot);
  }

  protected hasMediaTop(): boolean {
    return this.hasStudioBadge() || this.hasTopRightSlot();
  }

  protected hasMediaFooter(): boolean {
    return Boolean(this.mediaFooterSlot);
  }

  protected hasBody(): boolean {
    return Boolean(this.bodySlot);
  }

  protected primaryLinkIsExternal(): boolean {
    return this.primaryLink?.kind === 'external';
  }

  protected primaryRouterCommands(): string | readonly unknown[] | null {
    return this.primaryLink?.kind === 'router' ? this.primaryLink.commands : null;
  }

  protected primaryQueryParams(): Params | null {
    return this.primaryLink?.kind === 'router' ? (this.primaryLink.queryParams ?? null) : null;
  }

  protected primaryExternalHref(): string | null {
    if (this.primaryLink?.kind !== 'external') {
      return null;
    }

    const href = this.primaryLink.href.trim();
    return href.length > 0 ? href : null;
  }

  protected primaryLinkLabel(): string {
    const ariaLabel = this.primaryLink?.ariaLabel?.trim() ?? '';
    return ariaLabel.length > 0 ? ariaLabel : this.item.title;
  }

  protected studioBadgeLabel(): string {
    return this.item.studio ?? 'Studio';
  }

  protected studioBadgeLinkIsExternal(): boolean {
    return this.studioBadgeLink?.kind === 'external';
  }

  protected studioBadgeRouterCommands(): string | readonly unknown[] | null {
    return this.studioBadgeLink?.kind === 'router' ? this.studioBadgeLink.commands : null;
  }

  protected studioBadgeQueryParams(): Params | null {
    return this.studioBadgeLink?.kind === 'router'
      ? (this.studioBadgeLink.queryParams ?? null)
      : null;
  }

  protected studioBadgeExternalHref(): string | null {
    if (this.studioBadgeLink?.kind !== 'external') {
      return null;
    }

    const href = this.studioBadgeLink.href.trim();
    return href.length > 0 ? href : null;
  }

  protected studioBadgeAriaLabel(): string {
    const ariaLabel = this.studioBadgeLink?.ariaLabel?.trim() ?? '';
    return ariaLabel.length > 0 ? ariaLabel : this.studioBadgeLabel();
  }
}
