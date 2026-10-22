import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthStateStore } from '../../core/api/auth-state.store';
import { HomeService } from '../../core/api/home.service';
import { HomeAttention } from '../../core/api/home.types';
import { readUserCache, writeUserCache } from '../../core/cache/user-cache';

/** Last visit's counts are shown while fresh ones load, if not older than this. */
const ATTENTION_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ATTENTION_CACHE_KEY = 'home.attention';

export interface NeedsYouRow {
  id: keyof HomeAttention;
  icon: string;
  label: string;
  count: number;
  path: string;
  queryParams: Record<string, string> | null;
}

/**
 * "Needs you" card at the top of Home: only things waiting on the user, each
 * linking to where to act. Rows with nothing (or an unreachable source) are
 * left out, and the whole card hides when nothing needs the user.
 */
@Component({
  selector: 'app-needs-you-card',
  imports: [RouterLink],
  templateUrl: './needs-you-card.component.html',
  styleUrl: './needs-you-card.component.scss',
})
export class NeedsYouCardComponent implements OnInit, OnDestroy {
  private readonly homeService = inject(HomeService);
  private readonly authState = inject(AuthStateStore);
  private subscription: Subscription | null = null;

  protected readonly attention = signal<HomeAttention | null>(null);

  protected readonly rows = computed<NeedsYouRow[]>(() => {
    const attention = this.attention();
    if (!attention) {
      return [];
    }
    const rows: Array<Omit<NeedsYouRow, 'count'> & { count: number | null }> = [
      {
        id: 'matchesToCheck',
        icon: 'pi pi-check-circle',
        label: 'Matches to check',
        count: attention.matchesToCheck,
        path: '/tools/organize',
        queryParams: { tab: 'match' },
      },
      {
        id: 'failed',
        icon: 'pi pi-exclamation-triangle',
        label: 'Stuck downloads',
        count: attention.failed,
        path: '/acquisition',
        queryParams: { lifecycle: 'FAILED' },
      },
      {
        id: 'waitingForImport',
        icon: 'pi pi-inbox',
        label: 'Waiting for import',
        count: attention.waitingForImport,
        path: '/acquisition',
        queryParams: { lifecycle: 'IMPORT_PENDING' },
      },
      {
        id: 'unmatched',
        icon: 'pi pi-link',
        label: 'Scenes not matched',
        count: attention.unmatched,
        path: '/tools/organize',
        queryParams: null,
      },
    ];
    return rows.filter((row): row is NeedsYouRow => typeof row.count === 'number' && row.count > 0);
  });

  ngOnInit(): void {
    const cached = readUserCache<HomeAttention>(
      this.cacheUser(),
      ATTENTION_CACHE_KEY,
      ATTENTION_CACHE_MAX_AGE_MS,
    );
    if (cached && typeof cached === 'object') {
      this.attention.set(cached);
    }
    this.subscription = this.homeService.getAttention().subscribe({
      next: (attention) => {
        this.attention.set(attention);
        writeUserCache(this.cacheUser(), ATTENTION_CACHE_KEY, attention);
      },
      // Home never breaks over this card: without fresh counts it just hides.
      error: () => this.attention.set(null),
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private cacheUser(): string | null {
    const status = this.authState.status();
    return status?.authenticated ? status.username : null;
  }
}
