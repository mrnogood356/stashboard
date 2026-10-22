import {
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Observable, Subscription } from 'rxjs';
import { OwnedCopy } from '../../core/api/discover.types';
import { CatalogProviderType } from '../../core/api/integrations.types';
import {
  ReleaseSearchResult,
  ReleasesApiService,
  WhisparrRelease,
} from '../../core/api/releases.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { OwnedCopiesWarningComponent } from '../owned-copies-warning/owned-copies-warning.component';

export type ReleaseSort = 'best' | 'size-desc' | 'size-asc' | 'seeders';

/** Where releases come from: Whisparr for its own scenes, Prowlarr for any scene. */
export type ReleaseSource = 'whisparr' | 'prowlarr';

const SORTS: Array<{ id: ReleaseSort; label: string }> = [
  { id: 'best', label: 'Best' },
  { id: 'seeders', label: 'Seeders' },
  { id: 'size-desc', label: 'Biggest' },
  { id: 'size-asc', label: 'Smallest' },
];

/**
 * "Pick a release": Whisparr's interactive search as a sheet. Shows every
 * release the indexers found, with size, quality, seeders and age, and
 * downloads the one you choose. Indexers match loosely, so releases whose
 * name doesn't fit the scene are hidden until you ask for them, and you can
 * type to narrow the list by name.
 *
 * With source "prowlarr" it's "Find downloads" instead: the same list from
 * Prowlarr's indexers, for scenes Whisparr can't request, and each release
 * has its own Download button.
 */
@Component({
  selector: 'app-release-picker',
  imports: [NgTemplateOutlet, OwnedCopiesWarningComponent],
  templateUrl: './release-picker.component.html',
  styleUrl: './release-picker.component.scss',
})
export class ReleasePickerComponent implements OnChanges, OnDestroy {
  private readonly api = inject(ReleasesApiService);
  private readonly notifications = inject(AppNotificationsService);

  @Input() open = false;
  @Input() stashId: string | null = null;
  @Input() sceneTitle: string | null = null;
  @Input() source: ReleaseSource = 'whisparr';
  /** The catalog the scene is from; Prowlarr searches need it. */
  @Input() provider: CatalogProviderType | null = null;
  @Output() readonly closed = new EventEmitter<void>();
  @Output() readonly grabbed = new EventEmitter<WhisparrRelease>();
  @ViewChild('sheet') private sheet?: ElementRef<HTMLElement>;

  protected readonly sorts = SORTS;
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Why the search may have come back empty, on Whisparr's side. */
  protected readonly notice = signal<string | null>(null);
  protected readonly releases = signal<WhisparrRelease[]>([]);
  protected readonly sort = signal<ReleaseSort>('best');
  protected readonly showSkipped = signal(false);
  protected readonly showWeak = signal(false);
  /** What Prowlarr was asked for, so you can see it and search your own way. */
  protected readonly queries = signal<string[]>([]);
  /** Your own Prowlarr search, when you typed one. */
  protected readonly typedQuery = signal('');
  /** Words every shown release name has to contain. */
  protected readonly filterText = signal('');
  protected readonly selected = signal<string | null>(null);
  protected readonly grabbing = signal(false);
  /** The release being sent, for its button's spinner. */
  private readonly grabbingKey = signal<string | null>(null);
  /** Copies you likely already have; the release list waits behind them. */
  protected readonly ownedCopies = signal<OwnedCopy[]>([]);
  protected readonly ownedAcknowledged = signal(false);
  protected readonly showOwnedWarning = computed(
    () => this.ownedCopies().length > 0 && !this.ownedAcknowledged(),
  );

  protected readonly skippedCount = computed(
    () => this.releases().filter((release) => release.rejected).length,
  );
  /** Weak matches among the ones not already hidden as skipped. */
  protected readonly weakCount = computed(
    () =>
      this.releases().filter(
        (release) => isWeak(release) && (this.showSkipped() || !release.rejected),
      ).length,
  );
  /** Shown before the name filter: skipped and weak ones only when asked. */
  private readonly unfiltered = computed(() =>
    this.releases().filter(
      (release) =>
        (this.showSkipped() || !release.rejected) && (this.showWeak() || !isWeak(release)),
    ),
  );
  private readonly filterWords = computed(() => words(this.filterText()));
  protected readonly filtering = computed(() => this.filterWords().length > 0);
  /** How many of the shown releases the typed words leave. */
  protected readonly filterCount = computed(() => this.visible().length);
  protected readonly unfilteredCount = computed(() => this.unfiltered().length);
  protected readonly visible = computed(() => {
    const terms = this.filterWords();
    const list = terms.length
      ? this.unfiltered().filter((release) => {
          const name = words(release.title).join(' ');
          return terms.every((term) => name.includes(term));
        })
      : this.unfiltered();
    const sort = this.sort();
    if (sort === 'best') {
      return list;
    }
    return [...list].sort((left, right) => {
      if (sort === 'seeders') {
        return (right.seeders ?? -1) - (left.seeders ?? -1);
      }
      const diff = (left.size ?? 0) - (right.size ?? 0);
      return sort === 'size-asc' ? diff : -diff;
    });
  });
  protected readonly selectedRelease = computed(
    () => this.releases().find((release) => key(release) === this.selected()) ?? null,
  );

  private subscription: Subscription | null = null;
  private ownedSubscription: Subscription | null = null;
  private previousFocus: HTMLElement | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['open'] || changes['stashId']) && this.open && this.stashId) {
      this.previousFocus = document.activeElement as HTMLElement | null;
      this.typedQuery.set('');
      this.checkOwnedCopies(this.stashId);
      this.search();
      setTimeout(() => this.sheet?.nativeElement.focus(), 0);
    }
    if (changes['open'] && !this.open) {
      this.subscription?.unsubscribe();
      this.ownedSubscription?.unsubscribe();
    }
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.ownedSubscription?.unsubscribe();
  }

  protected downloadAnyway(): void {
    this.ownedAcknowledged.set(true);
  }

  /**
   * Before a download (Prowlarr to SABnzbd, or a Whisparr release): is there
   * a copy you already have? The search runs meanwhile; a failed check just
   * means no warning.
   */
  private checkOwnedCopies(stashId: string): void {
    this.ownedSubscription?.unsubscribe();
    this.ownedCopies.set([]);
    this.ownedAcknowledged.set(false);
    this.ownedSubscription = this.api.ownedCopies(stashId, this.provider).subscribe({
      next: (result) => this.ownedCopies.set(result.copies ?? []),
      error: () => this.ownedCopies.set([]),
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.open && !this.grabbing()) {
      this.close();
    }
  }

  protected search(): void {
    if (!this.stashId) {
      return;
    }
    this.subscription?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.selected.set(null);
    this.releases.set([]);
    this.notice.set(null);
    this.filterText.set('');
    // Your own words find what the scene's details didn't: show everything.
    this.showWeak.set(!!this.typedQuery());
    this.subscription = this.runSearch(this.stashId).subscribe({
      next: (result) => {
        this.loading.set(false);
        this.releases.set(result.releases);
        this.queries.set(result.queries ?? []);
        this.notice.set(result.notice ?? null);
        this.showSkipped.set(
          result.releases.length > 0 && result.releases.every((release) => release.rejected),
        );
      },
      error: (error: { error?: { message?: string } }) => {
        this.loading.set(false);
        this.error.set(
          error?.error?.message ??
            `${this.serviceName()} didn’t answer. Check that it’s running and try again.`,
        );
      },
    });
  }

  protected close(): void {
    this.subscription?.unsubscribe();
    this.closed.emit();
    this.previousFocus?.focus?.();
  }

  protected choose(release: WhisparrRelease): void {
    this.selected.set(this.selected() === key(release) ? null : key(release));
  }

  protected isSelected(release: WhisparrRelease): boolean {
    return this.selected() === key(release);
  }

  protected viaProwlarr(): boolean {
    return this.source === 'prowlarr';
  }

  protected isGrabbing(release: WhisparrRelease): boolean {
    return this.grabbingKey() === key(release);
  }

  /** Downloads the release given (a row's button), or the chosen one. */
  protected grab(release: WhisparrRelease | null = this.selectedRelease()): void {
    if (!release || !this.stashId || this.grabbing()) {
      return;
    }
    this.grabbing.set(true);
    this.grabbingKey.set(key(release));
    this.runGrab(this.stashId, release).subscribe({
      next: (result) => {
        this.grabbing.set(false);
        this.grabbingKey.set(null);
        this.notifications.success(
          'Downloading',
          result.sentTo === 'sabnzbd'
            ? 'SABnzbd is downloading it. Stashboard moves it into your library when it’s done.'
            : this.viaProwlarr()
              ? 'Prowlarr sent it to its download client.'
              : 'Whisparr sent it to your download client.',
        );
        this.grabbed.emit(release);
        this.close();
      },
      error: (error: { error?: { message?: string } }) => {
        this.grabbing.set(false);
        this.grabbingKey.set(null);
        this.notifications.error(
          'Couldn’t download that one',
          error?.error?.message ?? 'Try another release.',
        );
      },
    });
  }

  private serviceName(): string {
    return this.viaProwlarr() ? 'Prowlarr' : 'Whisparr';
  }

  private runSearch(stashId: string): Observable<ReleaseSearchResult> {
    return this.viaProwlarr()
      ? this.api.searchProwlarr(stashId, this.provider ?? 'STASHDB', this.typedQuery())
      : this.api.search(stashId);
  }

  private runGrab(
    stashId: string,
    release: WhisparrRelease,
  ): Observable<{ accepted: true; sentTo?: 'prowlarr' | 'sabnzbd' }> {
    return this.viaProwlarr()
      ? this.api.grabProwlarr(stashId, this.provider ?? 'STASHDB', release)
      : this.api.grab(stashId, release);
  }

  /** Searches Prowlarr for your own words; empty goes back to the scene's details. */
  protected searchFor(value: string): void {
    this.typedQuery.set(value.trim());
    this.search();
  }

  protected onFilterInput(value: string): void {
    this.filterText.set(value);
  }

  protected clearFilter(): void {
    this.filterText.set('');
  }

  protected matchLabel(release: WhisparrRelease): string | null {
    switch (release.match?.strength) {
      case 'strong':
        return 'Good match';
      case 'partial':
        return 'Partial match';
      case 'weak':
        return 'Weak match';
      default:
        return null;
    }
  }

  /** "Matches studio, date" or, for a weak one, why it's weak. */
  protected matchDetail(release: WhisparrRelease): string | null {
    const match = release.match;
    if (!match) {
      return null;
    }
    if (match.strength === 'weak') {
      return match.matched.length
        ? `Only matches ${match.matched.join(', ')}; probably another scene`
        : 'Nothing in the name matches this scene';
    }
    return `Matches ${match.matched.join(', ')}`;
  }

  protected trackKey(_: number, release: WhisparrRelease): string {
    return key(release);
  }

  protected size(bytes: number | null): string {
    if (!bytes || bytes <= 0) {
      return '—';
    }
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  protected age(hours: number | null): string | null {
    if (hours === null) {
      return null;
    }
    if (hours < 1) {
      return 'just now';
    }
    if (hours < 48) {
      return `${Math.round(hours)}h old`;
    }
    const days = Math.round(hours / 24);
    if (days < 60) {
      return `${days}d old`;
    }
    const months = Math.round(days / 30);
    return months < 24 ? `${months}mo old` : `${Math.round(days / 365)}y old`;
  }
}

function key(release: WhisparrRelease): string {
  return `${release.indexerId}:${release.guid}`;
}

function isWeak(release: WhisparrRelease): boolean {
  return release.match?.strength === 'weak';
}

/** Lowercase words, so "jane doe" finds "Jane.Doe" and "Jane_Doe". */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
