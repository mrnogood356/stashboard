import { Component, DestroyRef, Input, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  Subject,
  catchError,
  debounceTime,
  defer,
  distinctUntilChanged,
  map,
  of,
  switchMap,
} from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DiscoverService } from '../../core/api/discover.service';
import { PerformerFeedItem, PerformerFeedResponse } from '../../core/api/discover.types';

const PAGE_SIZE = 24;

/**
 * A catalog studio's performers: everyone in its scenes, most scenes first,
 * searchable by name, a page at a time. Each opens their catalog page.
 */
@Component({
  selector: 'app-studio-performers',
  imports: [RouterLink],
  templateUrl: './studio-performers.component.html',
  styleUrl: './studio-performers.component.scss',
})
export class StudioPerformersComponent implements OnInit {
  private readonly discover = inject(DiscoverService);
  private readonly destroyRef = inject(DestroyRef);

  private currentStudioId = '';
  private started = false;

  /** A new studio (the page is reused when going from one to another) starts over. */
  @Input({ required: true })
  set studioId(value: string) {
    if (value === this.currentStudioId) {
      return;
    }
    this.currentStudioId = value;
    this.query.set('');
    this.name = '';
    if (this.started) {
      this.load(1);
    }
  }
  get studioId(): string {
    return this.currentStudioId;
  }
  /** Where a performer's page goes back to. */
  @Input() returnTo = '';

  protected readonly query = signal('');
  protected readonly performers = signal<PerformerFeedItem[]>([]);
  protected readonly total = signal(0);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  /** The name searched for, as last sent. */
  private name = '';
  /** The last page that came back. */
  private page = 0;
  private readonly names = new Subject<{ studioId: string; name: string }>();
  private readonly requests = new Subject<{ studioId: string; name: string; page: number }>();

  ngOnInit(): void {
    // Typing waits for a pause; the same name again (say, a trailing space) is no new search.
    // The studio is part of the key: the same name in the next studio is a new search, and
    // one typed for the last studio, still waiting, is dropped.
    this.names
      .pipe(
        debounceTime(250),
        distinctUntilChanged((a, b) => a.studioId === b.studioId && a.name === b.name),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ studioId, name }) => {
        if (studioId === this.currentStudioId && name !== this.name) {
          this.name = name;
          this.load(1);
        }
      });
    // A newer request replaces one still on its way.
    this.requests
      .pipe(
        switchMap((request) =>
          // Deferred, so even a request that throws ends as "couldn't load".
          defer(() =>
            this.discover.getPerformersFeed(request.page, PAGE_SIZE, {
              name: request.name || undefined,
              studioId: request.studioId,
              sort: 'SCENE_COUNT',
              direction: 'DESC',
            }),
          ).pipe(
            map((response) => ({ request, response })),
            catchError(() => of({ request, response: null as PerformerFeedResponse | null })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ request, response }) => {
        this.loading.set(false);
        if (!response) {
          // The same page is asked for again next time.
          this.failed.set(true);
          return;
        }
        this.failed.set(false);
        this.page = request.page;
        this.total.set(response.total);
        this.hasMore.set(response.hasMore);
        this.performers.update((list) =>
          request.page === 1 ? response.items : [...list, ...response.items],
        );
      });
    this.started = true;
    this.load(1);
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    this.names.next({ studioId: this.currentStudioId, name: value.trim() });
  }

  protected more(): void {
    if (!this.loading()) {
      this.load(this.page + 1);
    }
  }

  private load(page: number): void {
    if (page === 1) {
      // Another search or studio: the old list isn't shown as its results.
      this.performers.set([]);
      this.total.set(0);
      this.hasMore.set(false);
      this.page = 0;
    }
    this.loading.set(true);
    this.failed.set(false);
    this.requests.next({ studioId: this.currentStudioId, name: this.name, page });
  }

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }
}
