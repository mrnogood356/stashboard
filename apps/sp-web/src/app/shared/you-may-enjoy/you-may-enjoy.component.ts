import {
  Component,
  Input,
  OnInit,
  booleanAttribute,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { SceneRequestContext } from '../../core/api/discover.types';
import { Suggestion, SuggestionsApiService } from '../../core/api/suggestions.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SceneCardComponent } from '../scene-card/scene-card.component';
import { SceneRequestModalComponent } from '../scene-request-modal/scene-request-modal.component';

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
  imports: [RouterLink, SceneCardComponent, SceneRequestModalComponent],
  templateUrl: './you-may-enjoy.component.html',
  styleUrl: './you-may-enjoy.component.scss',
})
export class YouMayEnjoyComponent implements OnInit {
  /** Its own page: every pick, as a grid on phones too, without the section's heading. */
  @Input({ transform: booleanAttribute }) full = false;

  private readonly api = inject(SuggestionsApiService);
  private readonly notifications = inject(AppNotificationsService);

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

  private get limit(): number {
    return this.full ? 60 : 24;
  }

  ngOnInit(): void {
    this.api.list(this.limit).subscribe({
      next: (result) => {
        this.items.set(result.items);
        this.message.set(result.message);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }

  /** A fresh set of picks now, in place of this one. */
  protected shuffle(): void {
    if (this.shuffling()) {
      return;
    }
    this.shuffling.set(true);
    this.api.shuffle(this.limit).subscribe({
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
    this.api.list(this.limit).subscribe({
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
