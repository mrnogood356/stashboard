import { DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, timer } from 'rxjs';
import { SceneRequestContext } from '../../core/api/discover.types';
import {
  Follow,
  FollowChanges,
  FollowedRelease,
  FollowsApiService,
  describeFollow,
} from '../../core/api/follows.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SceneCardComponent } from '../../shared/scene-card/scene-card.component';
import { SceneRequestModalComponent } from '../../shared/scene-request-modal/scene-request-modal.component';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';
import { FollowSheetComponent } from '../../shared/follow-sheet/follow-sheet.component';

type FollowingTab = 'new' | 'recent' | 'manage';
const TABS: readonly FollowingTab[] = ['new', 'recent', 'manage'];

/** While a check runs, look again this often for it to finish. */
const CHECK_POLL_MS = 4000;

/**
 * Following: new scenes from the performers and studios you follow, waiting
 * for you to request or pass on; everything found lately; and the follows
 * themselves, each with how far back it reaches and whether it requests on
 * its own.
 */
@Component({
  selector: 'app-following-page',
  imports: [
    DatePipe,
    RouterLink,
    SceneCardComponent,
    SceneRequestModalComponent,
    SectionBackComponent,
    FollowSheetComponent,
  ],
  templateUrl: './following-page.component.html',
  styleUrls: ['../tools/tools-shared.scss', './following-page.component.scss'],
})
export class FollowingPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(FollowsApiService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private pollSub: Subscription | null = null;

  protected readonly tab = signal<FollowingTab>('new');
  protected readonly releases = signal<FollowedRelease[] | null>(null);
  protected readonly reviewCount = signal(0);
  protected readonly releasesFailed = signal(false);
  protected readonly follows = signal<Follow[] | null>(null);
  protected readonly followsFailed = signal(false);
  protected readonly checking = signal(false);
  /** The follow whose options sheet is open. */
  protected readonly sheetFollow = signal<Follow | null>(null);
  protected readonly requestContext = signal<SceneRequestContext | null>(null);
  protected readonly describe = describeFollow;
  /** Bumped on each releases load, so an older answer can't replace a newer one. */
  private releasesGeneration = 0;

  /** Performers, then studios. */
  protected readonly groups = computed(() => {
    const follows = this.follows() ?? [];
    return [
      { label: 'Performers', items: follows.filter((follow) => follow.kind === 'PERFORMER') },
      { label: 'Studios', items: follows.filter((follow) => follow.kind === 'STUDIO') },
    ];
  });

  ngOnInit(): void {
    const asked = this.route.snapshot.queryParamMap.get('tab') as FollowingTab | null;
    this.tab.set(asked && TABS.includes(asked) ? asked : 'new');
    this.loadFollows();
    this.loadReleases();
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  protected select(tab: FollowingTab): void {
    if (this.tab() === tab) {
      return;
    }
    this.tab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'new' ? null : tab },
      replaceUrl: true,
    });
    if (tab !== 'manage') {
      this.loadReleases();
    }
  }

  protected checkNow(): void {
    if (this.checking()) {
      return;
    }
    this.checking.set(true);
    this.api.checkNow().subscribe({
      next: () => this.pollUntilChecked(),
      error: () => {
        this.checking.set(false);
        this.notifications.error('Couldn’t start a check', 'Try again in a moment.');
      },
    });
  }

  protected openRequest(context: SceneRequestContext): void {
    this.requestContext.set(context);
  }

  protected closeRequest(): void {
    this.requestContext.set(null);
  }

  /** Requested from the sheet: it leaves the review list. */
  protected onRequested(): void {
    const context = this.requestContext();
    this.requestContext.set(null);
    if (!context) {
      return;
    }
    if (this.tab() === 'new') {
      this.removeRelease(context.id);
    } else {
      this.loadReleases();
    }
  }

  protected dismiss(item: FollowedRelease): void {
    this.removeRelease(item.id);
    this.api.dismiss(item.id).subscribe({
      error: () => {
        this.loadReleases();
        this.notifications.error('Couldn’t pass on it', 'Try again.');
      },
    });
  }

  protected openSheet(follow: Follow): void {
    this.sheetFollow.set(follow);
  }

  protected closeSheet(): void {
    this.sheetFollow.set(null);
  }

  /**
   * Saved from the sheet. A change to its tags or start has the server look
   * again, so New is read again once that's done.
   */
  protected onSheetSaved(saved: Follow, changes: FollowChanges): void {
    this.sheetFollow.set(null);
    this.follows.update((list) =>
      (list ?? []).map((other) => (other.id === saved.id ? saved : other)),
    );
    if (changes.tags !== undefined || changes.since !== undefined) {
      this.checking.set(true);
      this.pollUntilChecked();
    }
  }

  protected onUnfollowed(follow: Follow): void {
    this.sheetFollow.set(null);
    this.follows.update((list) => (list ?? []).filter((other) => other.id !== follow.id));
    this.notifications.success(`Stopped following ${follow.name}`);
    this.loadReleases();
  }

  /** Tries again after a list couldn't be read. */
  protected retryFollows(): void {
    this.loadFollows();
  }

  protected retryReleases(): void {
    this.loadReleases();
  }

  protected entityRoute(kind: Follow['kind'], entityId: string): string[] {
    return [kind === 'PERFORMER' ? '/performer' : '/studio', entityId];
  }

  private removeRelease(sceneId: string): void {
    const before = this.releases()?.length ?? 0;
    this.releases.update((items) => (items ?? []).filter((item) => item.id !== sceneId));
    if ((this.releases()?.length ?? 0) < before) {
      this.reviewCount.update((count) => Math.max(0, count - 1));
    }
  }

  private loadReleases(): void {
    const view = this.tab() === 'recent' ? 'all' : 'review';
    const generation = ++this.releasesGeneration;
    this.releasesFailed.set(false);
    this.releases.set(null);
    this.api.releases(view, 120).subscribe({
      next: (result) => {
        if (generation !== this.releasesGeneration) {
          return;
        }
        this.releases.set(result.items);
        this.reviewCount.set(result.reviewCount);
      },
      error: () => {
        if (generation === this.releasesGeneration) {
          this.releasesFailed.set(true);
        }
      },
    });
  }

  private loadFollows(): void {
    this.followsFailed.set(false);
    this.api.list().subscribe({
      next: (result) => {
        this.follows.set(result.follows);
        if (result.checking && !this.pollSub) {
          this.checking.set(true);
          this.pollUntilChecked();
        }
      },
      error: () => this.followsFailed.set(true),
    });
  }

  private pollUntilChecked(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = timer(CHECK_POLL_MS, CHECK_POLL_MS).subscribe(() => {
      this.api.list().subscribe({
        next: (result) => {
          this.follows.set(result.follows);
          if (!result.checking) {
            this.pollSub?.unsubscribe();
            this.pollSub = null;
            this.checking.set(false);
            this.loadReleases();
          }
        },
        error: () => {
          this.pollSub?.unsubscribe();
          this.pollSub = null;
          this.checking.set(false);
          this.loadReleases();
        },
      });
    });
  }
}
