import { Component, DestroyRef, Input, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged, switchMap, catchError, of } from 'rxjs';
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

  @Input({ required: true }) studioId = '';
  /** Where a performer's page goes back to. */
  @Input() returnTo = '';

  protected readonly query = signal('');
  protected readonly performers = signal<PerformerFeedItem[]>([]);
  protected readonly total = signal(0);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  private page = 1;
  private readonly searches = new Subject<{ name: string; page: number }>();

  ngOnInit(): void {
    this.searches
      .pipe(
        debounceTime(250),
        distinctUntilChanged((a, b) => a.name === b.name && a.page === b.page),
        switchMap(({ name, page }) =>
          this.discover
            .getPerformersFeed(page, PAGE_SIZE, {
              name: name || undefined,
              studioId: this.studioId,
              sort: 'SCENE_COUNT',
              direction: 'DESC',
            })
            .pipe(catchError(() => of(null as PerformerFeedResponse | null))),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((response) => {
        this.loading.set(false);
        if (!response) {
          this.failed.set(true);
          return;
        }
        this.failed.set(false);
        this.total.set(response.total);
        this.hasMore.set(response.hasMore);
        this.performers.update((list) =>
          response.page === 1 ? response.items : [...list, ...response.items],
        );
      });
    this.search();
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    this.page = 1;
    this.loading.set(true);
    this.search();
  }

  protected more(): void {
    this.page += 1;
    this.search();
  }

  private search(): void {
    this.searches.next({ name: this.query().trim(), page: this.page });
  }

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }
}
