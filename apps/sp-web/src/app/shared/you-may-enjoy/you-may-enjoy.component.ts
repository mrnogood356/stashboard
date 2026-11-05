import { Component, OnInit, computed, inject, signal } from '@angular/core';
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
 * good. Nothing is requested by itself.
 */
@Component({
  selector: 'app-you-may-enjoy',
  imports: [SceneCardComponent, SceneRequestModalComponent],
  templateUrl: './you-may-enjoy.component.html',
  styleUrl: './you-may-enjoy.component.scss',
})
export class YouMayEnjoyComponent implements OnInit {
  private readonly api = inject(SuggestionsApiService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly items = signal<Suggestion[]>([]);
  protected readonly message = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly expanded = signal(false);
  protected readonly requestContext = signal<SceneRequestContext | null>(null);

  /** On a desktop the rest wait behind Show more; a phone swipes through them all. */
  protected readonly first = FIRST;
  protected readonly more = computed(() => Math.max(0, this.items().length - FIRST));

  ngOnInit(): void {
    this.api.list(24).subscribe({
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

  protected notInterested(item: Suggestion): void {
    this.items.update((items) => items.filter((entry) => entry.id !== item.id));
    this.api.dismiss(item).subscribe({
      error: () => {
        this.items.update((items) => [item, ...items]);
        this.notifications.error('Couldn’t hide it', 'Try again.');
      },
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
      this.items.update((items) => items.filter((entry) => entry.id !== context.id));
    }
  }
}
