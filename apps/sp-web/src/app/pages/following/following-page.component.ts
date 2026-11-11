import { DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, timer } from 'rxjs';
import { SceneRequestContext } from '../../core/api/discover.types';
import {
  Follow,
  FollowedRelease,
  FollowsApiService,
  SINCE_OPTIONS,
  sinceDaysAgo,
  sinceOptionFor,
} from '../../core/api/follows.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SceneCardComponent } from '../../shared/scene-card/scene-card.component';
import { SceneRequestModalComponent } from '../../shared/scene-request-modal/scene-request-modal.component';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';

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
  protected readonly savingId = signal<string | null>(null);
  protected readonly requestContext = signal<SceneRequestContext | null>(null);
  protected readonly sinceOptions = SINCE_OPTIONS;

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

  protected sinceChoice(follow: Follow): number {
    return sinceOptionFor(follow.since, follow.createdAt);
  }

  protected setSince(follow: Follow, value: string): void {
    const days = Number(value);
    this.save(follow, { since: sinceDaysAgo(Number.isFinite(days) ? days : 0) });
  }

  protected setAutoRequest(follow: Follow, autoRequest: boolean): void {
    this.save(follow, { autoRequest });
  }

  protected unfollow(follow: Follow): void {
    this.savingId.set(follow.id);
    this.api.unfollow(follow.id).subscribe({
      next: () => {
        this.savingId.set(null);
        this.follows.update((list) => (list ?? []).filter((other) => other.id !== follow.id));
        this.notifications.success(`Stopped following ${follow.name}`);
        this.loadReleases();
      },
      error: () => {
        this.savingId.set(null);
        this.notifications.error('Couldn’t unfollow', 'Try again.');
      },
    });
  }

  protected entityRoute(kind: Follow['kind'], entityId: string): string[] {
    return [kind === 'PERFORMER' ? '/performer' : '/studio', entityId];
  }

  private save(follow: Follow, changes: { since?: string; autoRequest?: boolean }): void {
    this.savingId.set(follow.id);
    this.api.update(follow.id, changes).subscribe({
      next: (saved) => {
        this.savingId.set(null);
        this.follows.update((list) =>
          (list ?? []).map((other) => (other.id === saved.id ? saved : other)),
        );
      },
      error: () => {
        this.savingId.set(null);
        // Redraw from what was saved.
        this.follows.update((list) => [...(list ?? [])]);
        this.notifications.error('Couldn’t save that', 'Try again.');
      },
    });
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
    this.releasesFailed.set(false);
    this.releases.set(null);
    this.api.releases(view, 120).subscribe({
      next: (result) => {
        if ((this.tab() === 'recent' ? 'all' : 'review') !== view) {
          return;
        }
        this.releases.set(result.items);
        this.reviewCount.set(result.reviewCount);
      },
      error: () => this.releasesFailed.set(true),
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
        },
      });
    });
  }
}
