import {
  Component,
  DestroyRef,
  Input,
  OnDestroy,
  OnInit,
  booleanAttribute,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink, Scroll } from '@angular/router';
import {
  Subject,
  catchError,
  debounceTime,
  distinctUntilChanged,
  filter,
  finalize,
  map,
  of,
  switchMap,
  take,
} from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { SceneRequestContext, SceneTagOption } from '../../core/api/discover.types';
import { Suggestion, SuggestionsApiService } from '../../core/api/suggestions.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SceneCardComponent } from '../scene-card/scene-card.component';
import { SceneRequestModalComponent } from '../scene-request-modal/scene-request-modal.component';
import { FilterChipComponent, FilterPanelDirective } from '../filter-bar/filter-chip.component';
import { FilterOption, FilterOptionsComponent } from '../filter-bar/filter-options.component';
import { pickedLabel } from '../filter-bar/filter-values';
import { RecentPick, readRecentPicks, rememberRecentPicks } from '../filter-bar/recent-picks';
import { YouMayEnjoyState } from './you-may-enjoy.state';

/** Shown at first; the rest behind "Show more". */
const FIRST = 8;

/**
 * Catalog scenes you don't have, picked from what you watch most, each with
 * why. Request opens the usual request sheet; Not interested hides it for
 * good. Nothing is requested by itself. A section at the end of Requests,
 * or (with `full`) the whole list on its own page.
 */
@Component({
  selector: 'app-you-may-enjoy',
  imports: [
    RouterLink,
    SceneCardComponent,
    SceneRequestModalComponent,
    FilterChipComponent,
    FilterPanelDirective,
    FilterOptionsComponent,
  ],
  templateUrl: './you-may-enjoy.component.html',
  styleUrl: './you-may-enjoy.component.scss',
})
export class YouMayEnjoyComponent implements OnInit, OnDestroy {
  /** Its own page: every pick, as a grid on phones too, without the section's heading. */
  @Input({ transform: booleanAttribute }) full = false;

  private readonly api = inject(SuggestionsApiService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly discover = inject(DiscoverService);
  private readonly router = inject(Router);
  private readonly state = inject(YouMayEnjoyState);
  private readonly destroyRef = inject(DestroyRef);
  private lastScrollY = 0;
  private readonly onScroll = () => {
    this.lastScrollY = window.scrollY;
  };

  protected readonly items = signal<Suggestion[]>([]);
  protected readonly message = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly expanded = signal(false);
  protected readonly requestContext = signal<SceneRequestContext | null>(null);
  protected readonly shuffling = signal(false);
  /** Taken off here (Not interested, requested), so a refill never brings them back. */
  private readonly removed = new Set<string>();

  /** On a desktop the rest wait behind Show more; a phone swipes through them all. */
  protected readonly first = FIRST;
  protected readonly more = computed(() =>
    this.full ? 0 : Math.max(0, this.items().length - FIRST),
  );

  /** The categories the picks are narrowed to; the same here and on Requests. */
  protected readonly tags = this.state.tags;
  protected readonly tagValue = computed(() => pickedLabel(this.tags().map((tag) => tag.name)));
  protected readonly tagSearchTerm = signal('');
  protected readonly tagSearchLoading = signal(false);
  private readonly tagResults = signal<SceneTagOption[]>([]);
  private readonly recentTags = signal<RecentPick[]>(readRecentPicks('catalog-tags'));
  private readonly tagSearches = new Subject<string>();
  /** Typed: what the catalog found. Not yet: what's picked, then recent ones. */
  protected readonly tagChoices = computed<FilterOption[]>(() => {
    if (this.tagSearchTerm().trim()) {
      return this.tagResults().map((tag) => ({ id: tag.id, label: tag.name }));
    }
    const picked = this.tags().map((tag) => ({ id: tag.id, label: tag.name }));
    const pickedIds = new Set(picked.map((option) => option.id));
    return [
      ...picked,
      ...this.recentTags()
        .filter((pick) => !pickedIds.has(pick.id))
        .map((pick) => ({ id: pick.id, label: pick.name, group: 'Recent' })),
    ];
  });
  protected readonly tagIds = computed(() => this.tags().map((tag) => tag.id));

  private get limit(): number {
    return this.full ? 60 : 24;
  }

  private get where(): 'page' | 'section' {
    return this.full ? 'page' : 'section';
  }

  ngOnInit(): void {
    this.tagSearches
      .pipe(
        map((term) => term.trim()),
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((term) => {
          if (!term) {
            return of<SceneTagOption[]>([]);
          }
          this.tagSearchLoading.set(true);
          return this.discover.searchSceneTags(term).pipe(
            catchError(() => of<SceneTagOption[]>([])),
            finalize(() => this.tagSearchLoading.set(false)),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((tags) => this.tagResults.set(tags));

    if (this.full) {
      window.addEventListener('scroll', this.onScroll, { passive: true });
    }
    // Back from a scene: the same picks, where you left them.
    const snapshot = this.state.restore(this.where);
    if (snapshot) {
      this.items.set(snapshot.items);
      this.message.set(snapshot.message);
      this.expanded.set(snapshot.expanded);
      this.loading.set(false);
      if (this.full) {
        this.restoreScroll(snapshot.scrollY);
      }
      return;
    }
    this.load();
  }

  ngOnDestroy(): void {
    window.removeEventListener('scroll', this.onScroll);
    if (!this.loading() && !this.failed()) {
      this.state.save(this.where, {
        tags: this.state.tagKey(),
        items: this.items(),
        message: this.message(),
        expanded: this.expanded(),
        scrollY: this.lastScrollY,
      });
    }
  }

  /** Scene links say where to come back to: this page, or Requests. */
  protected sceneQueryParams(): { returnTo: string } {
    return { returnTo: this.router.url };
  }

  protected onTagSearch(term: string): void {
    this.tagSearchTerm.set(term);
    this.tagSearches.next(term);
  }

  protected onTagsPicked(ids: string[]): void {
    const known = new Map<string, RecentPick>();
    for (const tag of [...this.recentTags(), ...this.tags()]) {
      known.set(tag.id, tag);
    }
    for (const tag of this.tagResults()) {
      known.set(tag.id, { id: tag.id, name: tag.name });
    }
    const picked = ids.flatMap((id) => {
      const tag = known.get(id);
      return tag ? [tag] : [];
    });
    if (picked.length > 0) {
      this.recentTags.set(rememberRecentPicks('catalog-tags', picked));
    }
    this.state.setTags(picked);
    this.expanded.set(false);
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.api.list(this.limit, this.tagIds()).subscribe({
      next: (result) => {
        this.items.set(result.items.filter((item) => !this.removed.has(item.id)));
        this.message.set(result.message);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }

  /** The router puts a page at the top once it opens; then go to where it was left. */
  private restoreScroll(scrollY: number): void {
    this.lastScrollY = scrollY;
    if (scrollY <= 0) {
      return;
    }
    this.router.events
      .pipe(
        filter((event) => event instanceof Scroll),
        take(1),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => requestAnimationFrame(() => this.scrollTo(scrollY, 10)));
  }

  private scrollTo(scrollY: number, attemptsLeft: number): void {
    window.scrollTo({ top: scrollY, behavior: 'instant' });
    if (Math.abs(window.scrollY - scrollY) > 1 && attemptsLeft > 0) {
      requestAnimationFrame(() => this.scrollTo(scrollY, attemptsLeft - 1));
    }
  }

  /** A fresh set of picks now, in place of this one. */
  protected shuffle(): void {
    if (this.shuffling()) {
      return;
    }
    this.shuffling.set(true);
    this.api.shuffle(this.limit, this.tagIds()).subscribe({
      next: (result) => {
        this.items.set(result.items.filter((item) => !this.removed.has(item.id)));
        this.message.set(result.message);
        this.expanded.set(false);
        this.failed.set(false);
        this.shuffling.set(false);
      },
      error: () => {
        this.shuffling.set(false);
        this.notifications.error('Couldn’t pick new scenes', 'Try again in a moment.');
      },
    });
  }

  protected notInterested(item: Suggestion): void {
    this.removed.add(item.id);
    this.items.update((items) => items.filter((entry) => entry.id !== item.id));
    this.api.dismiss(item).subscribe({
      next: () => this.refill(),
      error: () => {
        this.removed.delete(item.id);
        this.items.update((items) => [item, ...items]);
        this.notifications.error('Couldn’t hide it', 'Try again.');
      },
    });
  }

  /** The next picks in line fill the gaps, after what's already shown. */
  private refill(): void {
    this.api.list(this.limit, this.tagIds()).subscribe({
      next: (result) => {
        const shown = new Set(this.items().map((item) => item.id));
        const fresh = result.items.filter(
          (item) => !shown.has(item.id) && !this.removed.has(item.id),
        );
        const room = Math.max(0, this.limit - this.items().length);
        if (fresh.length > 0 && room > 0) {
          this.items.update((items) => [...items, ...fresh.slice(0, room)]);
        }
      },
      // The gap just stays until the next look.
      error: () => undefined,
    });
  }

  protected openRequest(context: SceneRequestContext): void {
    this.requestContext.set(context);
  }

  protected closeRequest(): void {
    this.requestContext.set(null);
  }

  /** Requested: it's on its way, so it leaves the suggestions. */
  protected onRequested(): void {
    const context = this.requestContext();
    this.requestContext.set(null);
    if (context) {
      this.removed.add(context.id);
      this.items.update((items) => items.filter((entry) => entry.id !== context.id));
      this.refill();
    }
  }
}
