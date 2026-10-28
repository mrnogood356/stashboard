import { Component, ElementRef, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { Params, RouterLink } from '@angular/router';
import { SceneRequestContext, SceneStatus } from '../../core/api/discover.types';
import {
  SceneCardMediaFooterDirective,
  SceneCardShellComponent,
  SceneCardShellItem,
  SceneCardShellLink,
  SceneCardTopRightDirective,
} from './scene-card-shell.component';
import { SceneStatusBadgeComponent } from '../scene-status-badge/scene-status-badge.component';
import { ReleaseSearchService } from '../../core/releases/release-search.service';
import { CatalogBrowseService } from '../../core/catalog/catalog-browse.service';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';

export interface SceneCardItem extends SceneCardShellItem {
  id: string;
  releaseDate: string | null;
  status?: SceneStatus | null;
}

export type SceneCardVariant = 'default' | 'rail';
export type SceneCardTone = 'media' | 'surface';
/** 'local' opens the scene page for a scene in your Stash library. */
export type SceneCardPrimaryLinkMode = 'scene' | 'external' | 'watch' | 'local';
/** 'studio' opens the studio's own page; 'scenes' / 'library' filter those pages by studio. */
export type SceneCardStudioBadgeRoute = 'none' | 'scenes' | 'library' | 'studio';

export interface SceneCardMenuAction {
  id: string;
  label: string;
  icon: string;
}

export interface SceneCardBadge {
  label: string;
}

@Component({
  selector: 'app-scene-card',
  imports: [
    RouterLink,
    SceneCardShellComponent,
    SceneCardTopRightDirective,
    SceneCardMediaFooterDirective,
    SceneStatusBadgeComponent,
  ],
  templateUrl: './scene-card.component.html',
  styleUrl: './scene-card.component.scss',
  host: {
    '[class.scene-card-variant-rail]': "variant === 'rail'",
    '[class.scene-card-variant-default]': "variant !== 'rail'",
    '[class.scene-card-tone-media]': "tone !== 'surface'",
    '[class.scene-card-tone-surface]': "tone === 'surface'",
    '(document:click)': 'closeMenuOnOutsideClick($event)',
    '(document:keydown.escape)': 'closeMenuOnEscape()',
  },
})
export class SceneCardComponent implements OnInit {
  @Input({ required: true }) item!: SceneCardItem;
  @Input() requestable = false;
  @Input() variant: SceneCardVariant = 'default';
  @Input() tone: SceneCardTone = 'media';
  @Input() primaryLinkMode: SceneCardPrimaryLinkMode = 'scene';
  @Input() sceneRouteId: string | null = null;
  @Input() sceneQueryParams: Params | null = null;
  @Input() externalHref: string | null = null;
  @Input() studioBadgeRoute: SceneCardStudioBadgeRoute = 'none';
  /** Query params for the 'studio' link, e.g. a returnTo for its back link. */
  @Input() studioQueryParams: Params | null = null;
  @Input() topBadges: readonly SceneCardBadge[] = [];
  @Input() footerLink: SceneCardShellLink | null = null;
  @Input() footerLinkLabel: string | null = null;
  @Input() footerBadgeLabel: string | null = null;
  /** Stash scene id; shows a Play button that opens the built-in player. */
  @Input() playSceneId: string | null = null;
  @Input() playQueryParams: Params | null = null;
  @Input() progress: number | null = null;
  /** Extra actions in a ⋯ menu on the picture (e.g. Continue Watching). */
  @Input() menuActions: readonly SceneCardMenuAction[] = [];
  @Output() menuAction = new EventEmitter<string>();

  protected menuOpen = false;
  private readonly releaseSearch = inject(ReleaseSearchService);
  private readonly catalogBrowse = inject(CatalogBrowseService);
  private readonly playbackSettings = inject(PlaybackSettingsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected toggleMenu(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.menuOpen = !this.menuOpen;
  }

  protected closeMenuOnOutsideClick(event: Event): void {
    if (this.menuOpen && !this.host.nativeElement.contains(event.target as Node | null)) {
      this.menuOpen = false;
    }
  }

  protected closeMenuOnEscape(): void {
    if (!this.menuOpen) {
      return;
    }
    this.menuOpen = false;
    // Back to the ⋯ button, so keyboard users keep their place.
    this.host.nativeElement.querySelector<HTMLElement>('.card-menu-trigger')?.focus();
  }

  protected chooseAction(actionId: string, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.menuOpen = false;
    this.menuAction.emit(actionId);
  }

  /**
   * Library scenes get Stash's preview clip on hover / press-and-hold, unless
   * Settings → Playback has card previews off.
   */
  protected previewUrl(): string | null {
    return this.playSceneId && this.playbackSettings.previewsEnabled()
      ? `/api/playback/scenes/${encodeURIComponent(this.playSceneId)}/preview`
      : null;
  }

  /** The Play button, unless Settings → Playback has playback off. */
  protected playCommands(): readonly unknown[] | null {
    return this.playSceneId && this.playbackSettings.playbackEnabled()
      ? ['/watch', this.playSceneId]
      : null;
  }

  @Output() request = new EventEmitter<SceneRequestContext>();

  /** "Aug 14, 2025" for full dates; anything else is shown as given. */
  protected formatDate(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      return value;
    }
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  protected shellVariant(): 'default' | 'rail' {
    return this.variant === 'rail' ? 'rail' : 'default';
  }

  protected statusIcon(): SceneStatus | null {
    const status = this.item.status;
    // Said once: not as an icon when the footer already says it in words.
    return status && status.state !== 'NOT_REQUESTED' && !this.showsFooterStatus() ? status : null;
  }

  /** The footer shows the status badge only when no Find or Search button takes its place. */
  protected showsFooterStatus(): boolean {
    return !!this.footerStatus() && !this.canFindDownloads() && !this.canSearchReleases();
  }

  protected primaryLink(): SceneCardShellLink {
    if (this.primaryLinkMode === 'external') {
      return {
        kind: 'external',
        href: this.externalHref ?? '',
        ariaLabel: this.item.title,
      };
    }

    // With playback off, a card that would play opens the library scene instead.
    const watchFallsBack =
      this.primaryLinkMode === 'watch' &&
      !!this.playSceneId &&
      !this.playbackSettings.playbackEnabled();

    if (this.primaryLinkMode === 'local' || watchFallsBack) {
      return {
        kind: 'router',
        commands: ['/library/scene', this.playSceneId ?? this.item.id],
        queryParams: this.sceneQueryParams ?? this.playQueryParams,
        ariaLabel: this.item.title,
      };
    }

    if (this.primaryLinkMode === 'watch' && this.playSceneId) {
      return {
        kind: 'router',
        commands: ['/watch', this.playSceneId],
        queryParams: this.playQueryParams,
        ariaLabel: `Play ${this.item.title}`,
      };
    }

    return {
      kind: 'router',
      commands: ['/scene', this.sceneRouteIdValue()],
      queryParams: this.sceneQueryParams,
      ariaLabel: this.item.title,
    };
  }

  protected studioBadgeLink(): SceneCardShellLink | null {
    if (this.studioBadgeRoute === 'none' || !this.item.studioId || !this.item.studio) {
      return null;
    }

    if (this.studioBadgeRoute === 'studio') {
      return {
        kind: 'router',
        commands: ['/studio', this.item.studioId],
        queryParams: this.studioQueryParams,
        ariaLabel: `View scenes from ${this.item.studio}`,
      };
    }

    return {
      kind: 'router',
      commands: [this.studioBadgeRoute === 'library' ? '/library' : '/scenes'],
      queryParams: {
        studios: this.item.studioId,
        studioNames: this.item.studio,
      },
      ariaLabel: `Filter ${this.studioBadgeRoute} by studio ${this.item.studio}`,
    };
  }

  protected footerLinkText(): string | null {
    if (!this.footerLink) {
      return null;
    }

    const label = this.footerLinkLabel?.trim() ?? '';
    return label.length > 0 ? label : null;
  }

  protected footerBadgeText(): string | null {
    const label = this.footerBadgeLabel?.trim() ?? '';
    return label.length > 0 ? label : null;
  }

  protected footerLinkIsExternal(): boolean {
    return this.footerLink?.kind === 'external';
  }

  protected footerLinkRouterCommands(): string | readonly unknown[] | null {
    return this.footerLink?.kind === 'router' ? this.footerLink.commands : null;
  }

  protected footerLinkQueryParams(): Params | null {
    return this.footerLink?.kind === 'router' ? (this.footerLink.queryParams ?? null) : null;
  }

  protected footerExternalHref(): string | null {
    if (this.footerLink?.kind !== 'external') {
      return null;
    }

    const href = this.footerLink.href.trim();
    return href.length > 0 ? href : null;
  }

  protected footerStatus(): SceneStatus | null {
    if (this.requestable || this.footerLinkText() || this.footerBadgeText()) {
      return null;
    }

    return this.item.status ?? null;
  }

  /**
   * A catalog scene Whisparr has but hasn't got a file for yet: its releases
   * can be picked right from the list.
   */
  protected canSearchReleases(): boolean {
    const state = this.item.status?.state;
    return (
      this.primaryLinkMode === 'scene' &&
      (state === 'REQUESTED' || state === 'DOWNLOADING' || state === 'FAILED')
    );
  }

  ngOnInit(): void {
    // Once for the whole app: whether lists can offer Find downloads.
    if (!this.requestable && this.catalogBrowse.providerForRequest()) {
      this.releaseSearch.checkProwlarr();
    }
  }

  /**
   * A scene from a catalog Whisparr can't request from (FansDB browsing):
   * with Prowlarr set up, it can be found and downloaded right from the list.
   */
  protected canFindDownloads(): boolean {
    const state = this.item.status?.state;
    const provider = this.catalogBrowse.providerForRequest();
    if (
      this.requestable ||
      this.primaryLinkMode !== 'scene' ||
      !provider ||
      (state && state !== 'NOT_REQUESTED')
    ) {
      return false;
    }
    return this.releaseSearch.prowlarrReady() === true;
  }

  protected findDownloads(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.releaseSearch.open({
      stashId: this.sceneRouteIdValue(),
      title: this.item.title,
      source: 'prowlarr',
      provider: this.catalogBrowse.providerForRequest(),
    });
  }

  protected searchReleases(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.releaseSearch.open({
      stashId: this.sceneRouteIdValue(),
      title: this.item.title,
      source: 'whisparr',
    });
  }

  protected requestScene(event: MouseEvent): void {
    event.stopPropagation();
    this.request.emit({
      id: this.item.id,
      title: this.item.title,
      imageUrl: this.item.imageUrl,
    });
  }

  private sceneRouteIdValue(): string {
    const sceneRouteId = this.sceneRouteId?.trim() ?? '';
    return sceneRouteId.length > 0 ? sceneRouteId : this.item.id;
  }
}
