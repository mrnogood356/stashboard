import { StageTrackComponent } from '../../shared/stage-track/stage-track.component';
import { GlassArtService } from '../../core/theme/glass-art.service';
import { Stage, stagesForStatus } from '../../shared/stage-track/stage-track';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import { Subscription, combineLatest, finalize } from 'rxjs';
import { ButtonDirective } from 'primeng/button';
import { Message } from 'primeng/message';
import { Select } from 'primeng/select';
import { DiscoverService } from '../../core/api/discover.service';
import { ReleasesApiService } from '../../core/api/releases.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import {
  SceneDetails,
  ScenePerformer,
  SceneRequestContext,
  isSceneStatusRequestable,
} from '../../core/api/discover.types';
import { HideToggleComponent } from '../../shared/hide-toggle/hide-toggle.component';
import { SceneRequestModalComponent } from '../../shared/scene-request-modal/scene-request-modal.component';
import { SceneStatusBadgeComponent } from '../../shared/scene-status-badge/scene-status-badge.component';
import { ReleasePickerComponent } from '../../shared/release-picker/release-picker.component';
import { SceneEvidenceComponent } from '../../shared/scene-evidence/scene-evidence.component';
import { SceneTimelineComponent } from '../../shared/scene-timeline/scene-timeline.component';
import { TimelineAction } from '../../core/api/timeline.service';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';

@Component({
  selector: 'app-scene-page',
  imports: [
    StageTrackComponent,
    HideToggleComponent,
    RouterLink,
    FormsModule,
    Message,
    Select,
    ButtonDirective,
    SceneStatusBadgeComponent,
    SceneRequestModalComponent,
    ReleasePickerComponent,
    SceneEvidenceComponent,
    SceneTimelineComponent,
  ],
  templateUrl: './scene-page.component.html',
  styleUrl: './scene-page.component.scss',
})
export class ScenePageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly discoverService = inject(DiscoverService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly releasesApi = inject(ReleasesApiService);
  /** Settings → Playback: off hides the Play button. */
  protected readonly playbackOn = inject(PlaybackSettingsService).playbackEnabled;
  private previousFocusedElement: HTMLElement | null = null;
  private routeSubscription: Subscription | null = null;
  private sceneRequest: Subscription | null = null;
  private requestedSceneId: string | null = null;

  private requestTriggerButton?: ElementRef<HTMLButtonElement>;
  private requestButtonObserver: IntersectionObserver | null = null;
  /** The phone's pinned Request bar only shows once the main button is off screen. */
  protected readonly requestButtonOnScreen = signal(true);

  @ViewChild('requestTriggerButton')
  private set requestTrigger(ref: ElementRef<HTMLButtonElement> | undefined) {
    this.requestTriggerButton = ref;
    this.requestButtonObserver?.disconnect();
    this.requestButtonObserver = null;
    this.requestButtonOnScreen.set(true);
    if (!ref || typeof IntersectionObserver === 'undefined') {
      return;
    }
    this.requestButtonObserver = new IntersectionObserver(([entry]) =>
      this.requestButtonOnScreen.set(entry?.isIntersecting ?? true),
    );
    this.requestButtonObserver.observe(ref.nativeElement);
  }

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly scene = signal<SceneDetails | null>(null);
  private readonly glassArt = inject(GlassArtService).follow(() => this.scene()?.imageUrl);
  protected readonly descriptionExpanded = signal(false);
  protected readonly selectedStashCopyUrl = signal<string | null>(null);
  protected readonly requestModalOpen = signal(false);
  protected readonly releasePickerOpen = signal(false);
  protected readonly findDownloadsOpen = signal(false);
  /** Whether Prowlarr is set up; null until known. */
  protected readonly prowlarrConfigured = signal<boolean | null>(null);
  protected readonly requestContext = signal<SceneRequestContext | null>(null);
  protected readonly favoritingStudio = signal(false);
  protected readonly performerFavoriteInFlightById = signal<Record<string, boolean>>({});
  protected readonly backLinkPath = signal('/scenes');
  protected readonly backLinkQueryParams = signal<Params>({});
  protected readonly backLinkLabel = signal('Back to Scenes');

  ngOnInit(): void {
    this.releasesApi.prowlarrStatus().subscribe({
      next: (status) => this.prowlarrConfigured.set(status.prowlarr.configured),
      error: () => this.prowlarrConfigured.set(false),
    });
    this.routeSubscription = combineLatest([
      this.route.paramMap,
      this.route.queryParamMap,
    ]).subscribe(([paramMap, queryParamMap]) => {
      const resolvedBackLink = this.parseReturnTo(queryParamMap.get('returnTo'), '/scenes');
      this.backLinkPath.set(resolvedBackLink.path);
      this.backLinkQueryParams.set(resolvedBackLink.queryParams);
      this.backLinkLabel.set(this.backLinkText(resolvedBackLink.path, 'Back to Scenes'));

      const stashIdParam = paramMap.get('stashId')?.trim();
      if (!stashIdParam) {
        this.error.set('Scene id is missing from the route.');
        this.loading.set(false);
        return;
      }

      // A change to the query alone (returnTo) doesn't need the scene again.
      if (stashIdParam === this.requestedSceneId && !this.error()) {
        return;
      }
      this.loadScene(stashIdParam);
    });
  }

  ngOnDestroy(): void {
    this.requestButtonObserver?.disconnect();
    this.routeSubscription?.unsubscribe();
    this.sceneRequest?.unsubscribe();
  }

  protected retry(): void {
    this.loadSceneByRoute();
  }

  protected toggleDescription(): void {
    this.descriptionExpanded.update((value) => !value);
  }

  protected hasStashCopy(scene: SceneDetails): boolean {
    return scene.stash?.exists === true && scene.stash.copies.length > 0;
  }

  protected hasMultipleStashCopies(scene: SceneDetails): boolean {
    return scene.stash?.hasMultipleCopies === true;
  }

  protected hasWhisparrLink(scene: SceneDetails): boolean {
    return scene.whisparr?.exists === true && scene.whisparr.viewUrl.length > 0;
  }

  protected selectedStashViewUrl(scene: SceneDetails): string | null {
    const selected = this.selectedStashCopyUrl();
    if (selected) {
      return selected;
    }

    return scene.stash?.copies[0]?.viewUrl ?? null;
  }

  /** Stash scene id of the selected copy, for the built-in player. */
  protected selectedStashSceneId(scene: SceneDetails): string | null {
    const selected = this.selectedStashViewUrl(scene);
    const copy = scene.stash?.copies.find((candidate) => candidate.viewUrl === selected);
    return copy?.id ?? scene.stash?.copies[0]?.id ?? null;
  }

  protected selectedStashLabel(scene: SceneDetails): string {
    const selected = this.selectedStashViewUrl(scene);
    if (!selected) {
      return 'View in Stash';
    }

    return scene.stash?.copies.find((copy) => copy.viewUrl === selected)?.label ?? 'View in Stash';
  }

  protected onStashCopySelected(viewUrl: string | null | undefined): void {
    this.selectedStashCopyUrl.set(viewUrl ?? null);
  }

  protected studioLogoAriaLabel(scene: SceneDetails): string {
    const studioName = scene.studio?.trim();
    return studioName ? `View studio ${studioName}` : 'View studio';
  }

  protected studioSiteAriaLabel(scene: SceneDetails): string {
    const studioName = scene.studio?.trim();
    if (studioName) {
      return `Open this scene on ${studioName}’s site`;
    }

    return 'Open this scene on the studio’s site';
  }

  protected formattedDuration(durationSeconds: number | null): string | null {
    if (!durationSeconds || durationSeconds <= 0) {
      return null;
    }

    const minutes = Math.round(durationSeconds / 60);
    if (minutes < 60) {
      return `${Math.max(1, minutes)} min`;
    }
    const rest = minutes % 60;
    return rest > 0 ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
  }

  /** "Jun 15, 2026" from the catalog's "2026-06-15". */
  protected formattedDate(value: string | null): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
    if (!match) {
      return value;
    }
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /** Release date and length on one line: "Jun 15, 2026 · 41 min". */
  protected metaLine(scene: SceneDetails): string | null {
    const parts = [this.formattedDate(scene.releaseDate), this.formattedDuration(scene.duration)];
    const line = parts.filter(Boolean).join(' · ');
    return line || null;
  }

  /** The header shows this many tags; the rest are one tap away. */
  protected readonly tagsShown = 8;
  protected readonly tagsExpanded = signal(false);

  /** Where it is, on the same four steps as Requests. */
  protected sceneStages(scene: SceneDetails): Stage[] {
    return stagesForStatus(scene.status.state, scene.status.queueState);
  }

  protected hasLongDescription(description: string | null): boolean {
    if (!description) {
      return false;
    }

    return this.normalizeDescription(description).length > 360;
  }

  protected displayedDescription(description: string | null): string | null {
    if (!description) {
      return null;
    }

    const normalized = this.normalizeDescription(description);
    if (this.descriptionExpanded() || normalized.length <= 360) {
      return normalized;
    }

    return `${normalized.slice(0, 357)}...`;
  }

  protected performerInitial(name: string): string {
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : '?';
  }

  protected formattedGender(gender: string | null): string | null {
    if (!gender || gender.trim().length === 0) {
      return null;
    }

    // The catalog says "FEMALE" or "TRANSGENDER_FEMALE": show "Female", "Transgender female".
    const words = gender.trim().replace(/_/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /** One plain line under the track. */
  protected lifecycleSummary(scene: SceneDetails): string {
    switch (scene.status.state) {
      case 'REQUESTED':
        return 'Whisparr has it and is looking for a release.';
      case 'DOWNLOADING':
        return 'Downloading now.';
      case 'IMPORT_PENDING':
        return 'Downloaded. Waiting for Stash to pick it up.';
      case 'AVAILABLE':
        return 'In your library.';
      case 'FAILED':
        return 'The download failed. Pick another release, or retry it in Whisparr.';
      case 'NOT_REQUESTED':
      default:
        return 'Not requested yet.';
    }
  }

  /** In Whisparr but not downloaded yet (or the download failed): choose the exact release. */
  protected canPickRelease(scene: SceneDetails): boolean {
    return (
      scene.whisparr?.exists === true &&
      !this.hasStashCopy(scene) &&
      scene.status.state !== 'AVAILABLE' &&
      scene.status.state !== 'IMPORT_PENDING'
    );
  }

  /**
   * Whisparr only knows StashDB scenes, so FansDB scenes (and any scene this
   * instance can't request) can only be downloaded through Prowlarr.
   */
  protected needsProwlarr(scene: SceneDetails): boolean {
    return (
      (scene.source === 'FANSDB' || scene.requestable === false) &&
      !this.hasStashCopy(scene) &&
      !this.canPickRelease(scene) &&
      scene.status.state !== 'AVAILABLE' &&
      scene.status.state !== 'IMPORT_PENDING'
    );
  }

  protected canFindDownloads(scene: SceneDetails): boolean {
    return this.prowlarrConfigured() === true && this.needsProwlarr(scene);
  }

  /** Says Prowlarr would help, when it isn't set up. */
  protected showProwlarrHint(scene: SceneDetails): boolean {
    return this.prowlarrConfigured() === false && this.needsProwlarr(scene);
  }

  /** The timeline is for scenes that were requested or are in the library. */
  protected showTimeline(scene: SceneDetails): boolean {
    return (
      scene.status.state !== 'NOT_REQUESTED' ||
      this.hasStashCopy(scene) ||
      scene.whisparr?.exists === true
    );
  }

  /** "Pick another release" and the like, from the timeline. */
  protected onTimelineAction(action: TimelineAction): void {
    if (action.kind === 'pick-release') {
      this.releasePickerOpen.set(true);
    } else if (action.kind === 'find-downloads') {
      this.findDownloadsOpen.set(true);
    }
  }

  protected onReleaseGrabbed(): void {
    this.releasePickerOpen.set(false);
    this.retry();
  }

  protected canRequestScene(scene: SceneDetails): boolean {
    return scene.requestable !== false && isSceneStatusRequestable(scene.status);
  }

  protected failedRemediationVisible(scene: SceneDetails): boolean {
    return scene.status.state === 'FAILED';
  }

  protected canToggleFavoriteStudio(scene: SceneDetails): boolean {
    if (!scene.studioId) {
      return false;
    }

    return !this.favoritingStudio();
  }

  protected studioFavoriteAriaLabel(scene: SceneDetails): string {
    const studioName = scene.studio?.trim();
    if (studioName) {
      return scene.studioIsFavorite
        ? `Unfavorite studio ${studioName}`
        : `Favorite studio ${studioName}`;
    }

    return scene.studioIsFavorite ? 'Unfavorite studio' : 'Favorite studio';
  }

  protected studioFavoriteTitle(scene: SceneDetails): string {
    return this.studioFavoriteAriaLabel(scene);
  }

  protected toggleFavoriteStudio(scene: SceneDetails): void {
    if (!scene.studioId) {
      this.notifications.info('Studio information is unavailable');
      return;
    }

    if (this.favoritingStudio()) {
      return;
    }

    const nextFavorite = !scene.studioIsFavorite;

    this.favoritingStudio.set(true);
    this.discoverService
      .favoriteStudio(scene.studioId, nextFavorite)
      .pipe(
        finalize(() => {
          this.favoritingStudio.set(false);
        }),
      )
      .subscribe({
        next: (result) => {
          this.scene.update((current) =>
            current ? { ...current, studioIsFavorite: nextFavorite } : current,
          );

          if (nextFavorite && result.alreadyFavorited) {
            this.notifications.info('Studio already favorited');
            return;
          }

          this.notifications.success(nextFavorite ? 'Studio favorited' : 'Studio unfavorited');
        },
        error: () => {
          this.notifications.error(
            nextFavorite ? 'Failed to favorite studio' : 'Failed to unfavorite studio',
          );
        },
      });
  }

  protected performerFavoriteToggleBusy(performerId: string): boolean {
    return this.performerFavoriteInFlightById()[performerId] === true;
  }

  protected performerFavoriteToggleLabel(isFavorite: boolean): string {
    return isFavorite ? 'Unfavorite performer' : 'Favorite performer';
  }

  protected toggleScenePerformerFavorite(event: Event, performer: ScenePerformer): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.performerFavoriteToggleBusy(performer.id)) {
      return;
    }

    const nextFavorite = !performer.isFavorite;
    this.setPerformerFavoriteBusy(performer.id, true);
    this.discoverService
      .favoritePerformer(performer.id, nextFavorite)
      .pipe(
        finalize(() => {
          this.setPerformerFavoriteBusy(performer.id, false);
        }),
      )
      .subscribe({
        next: (result) => {
          this.scene.update((current) =>
            current
              ? {
                  ...current,
                  performers: current.performers.map((currentPerformer) =>
                    currentPerformer.id === performer.id
                      ? { ...currentPerformer, isFavorite: nextFavorite }
                      : currentPerformer,
                  ),
                }
              : current,
          );

          if (nextFavorite && result.alreadyFavorited) {
            this.notifications.info('Performer already favorited');
            return;
          }

          this.notifications.success(
            nextFavorite ? 'Performer favorited' : 'Performer unfavorited',
          );
        },
        error: () => {
          this.notifications.error(
            nextFavorite ? 'Failed to favorite performer' : 'Failed to unfavorite performer',
          );
        },
      });
  }

  protected openRequestPanel(scene: SceneDetails): void {
    if (!this.canRequestScene(scene)) {
      return;
    }

    this.previousFocusedElement = document.activeElement as HTMLElement | null;
    this.requestContext.set({
      id: scene.id,
      title: scene.title,
      imageUrl: scene.imageUrl,
    });
    this.requestModalOpen.set(true);
  }

  protected onRequestModalClosed(): void {
    this.requestModalOpen.set(false);

    setTimeout(() => {
      const focusTarget = this.requestTriggerButton?.nativeElement ?? this.previousFocusedElement;
      focusTarget?.focus();
      this.previousFocusedElement = null;
    }, 0);
  }

  protected onRequestSubmitted(stashId: string): void {
    this.loadScene(stashId);
  }

  protected currentRouteUrl(): string {
    return this.router.url;
  }

  private loadSceneByRoute(): void {
    const stashIdParam = this.route.snapshot.paramMap.get('stashId')?.trim();
    if (!stashIdParam) {
      this.error.set('Scene id is missing from the route.');
      this.loading.set(false);
      return;
    }

    this.loadScene(stashIdParam);
  }

  private loadScene(stashIdParam: string): void {
    // Only the latest scene counts: cancel a request still on its way.
    this.sceneRequest?.unsubscribe();
    if (stashIdParam !== this.requestedSceneId) {
      this.scene.set(null);
    }
    this.requestedSceneId = stashIdParam;
    this.loading.set(true);
    this.error.set(null);
    this.descriptionExpanded.set(false);
    this.tagsExpanded.set(false);
    this.selectedStashCopyUrl.set(null);
    this.requestModalOpen.set(false);
    this.performerFavoriteInFlightById.set({});

    this.sceneRequest = this.discoverService
      .getSceneDetails(stashIdParam)
      .pipe(
        finalize(() => {
          this.loading.set(false);
        }),
      )
      .subscribe({
        next: (scene) => {
          this.scene.set(scene);
          this.selectedStashCopyUrl.set(scene.stash?.copies[0]?.viewUrl ?? null);
          this.requestContext.set({
            id: scene.id,
            title: scene.title,
            imageUrl: scene.imageUrl,
          });
        },
        error: () => {
          this.error.set('Failed to load scene details from the API.');
        },
      });
  }

  private normalizeDescription(description: string): string {
    return description.replaceAll(/\s+/g, ' ').trim();
  }

  private parseReturnTo(
    rawReturnTo: string | null,
    fallback: string,
  ): { path: string; queryParams: Params } {
    const trimmed = rawReturnTo?.trim();
    if (!trimmed) {
      return { path: fallback, queryParams: {} };
    }

    if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
      return { path: fallback, queryParams: {} };
    }

    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
      return { path: fallback, queryParams: {} };
    }

    try {
      const parsed = this.router.parseUrl(trimmed);
      const primarySegments = parsed.root.children['primary']?.segments ?? [];
      const path = `/${primarySegments.map((segment) => segment.path).join('/')}`;
      const canonicalPath = path === '/discover' ? '/scenes' : path;
      return {
        path: canonicalPath === '/' ? fallback : canonicalPath,
        queryParams: parsed.queryParams,
      };
    } catch {
      return { path: fallback, queryParams: {} };
    }
  }

  private backLinkText(returnTo: string, fallbackLabel: string): string {
    if (returnTo.startsWith('/home')) {
      return 'Back to Home';
    }
    if (returnTo.startsWith('/scenes')) {
      return 'Back to Scenes';
    }
    if (returnTo.startsWith('/acquisition')) {
      return 'Back to Requests';
    }
    if (returnTo.startsWith('/processing')) {
      return 'Back to Downloads';
    }
    if (returnTo.startsWith('/library')) {
      return 'Back to Library';
    }
    if (returnTo.startsWith('/performers')) {
      return 'Back to Performers';
    }
    if (returnTo.startsWith('/performer/')) {
      return 'Back to Performer';
    }
    if (returnTo.startsWith('/studios')) {
      return 'Back to Studios';
    }
    if (returnTo.startsWith('/studio/')) {
      return 'Back to Studio';
    }
    if (returnTo.startsWith('/scene/')) {
      return 'Back to Scene';
    }

    return fallbackLabel;
  }

  private setPerformerFavoriteBusy(performerId: string, busy: boolean): void {
    this.performerFavoriteInFlightById.update((current) => {
      if (busy) {
        return {
          ...current,
          [performerId]: true,
        };
      }

      const next = { ...current };
      delete next[performerId];
      return next;
    });
  }
}
