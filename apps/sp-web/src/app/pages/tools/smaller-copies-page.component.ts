import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  SmallerCopies,
  SmallerCopiesApiService,
  SmallerCopySettings,
} from '../../core/api/smaller-copies.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

const OUTCOMES: Record<string, string> = {
  grabbed: 'Grabbed',
  found: 'Match waiting',
  'none-found': 'Nothing yet',
  'no-catalog-id': 'Not matched',
  failed: 'Search failed',
  replaced: 'Replaced',
  'kept-both': 'Kept both',
};

/**
 * Library tools → Smaller copies: rules for which files to replace and with
 * what, how fast to search, and what's been found.
 */
@Component({
  selector: 'app-smaller-copies-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './smaller-copies-page.component.html',
  styleUrls: ['./tools-shared.scss', './smaller-copies-page.component.scss'],
})
export class SmallerCopiesPageComponent implements OnInit {
  private readonly api = inject(SmallerCopiesApiService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly data = signal<SmallerCopies | null>(null);
  protected readonly error = signal(false);
  protected readonly saving = signal(false);
  protected readonly searching = signal(false);
  /** Scenes with a grab on its way; each button stays off until its own answer. */
  protected readonly grabbing = signal<ReadonlySet<string>>(new Set());
  /** The form's copy, saved with Save. */
  protected form: SmallerCopySettings | null = null;
  protected studios = '';
  protected readonly hours = Array.from({ length: 24 }, (_, hour) => hour);

  ngOnInit(): void {
    this.api.status().subscribe({
      next: (data) => this.show(data),
      error: () => this.error.set(true),
    });
  }

  protected hourLabel(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  protected outcomeLabel(outcome: string): string {
    return OUTCOMES[outcome] ?? outcome;
  }

  protected gb(bytes: number | null): string {
    return bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '';
  }

  protected when(iso: string | null): string {
    if (!iso) {
      return '';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
  }

  protected save(): void {
    if (!this.form) {
      return;
    }
    const settings: SmallerCopySettings = {
      ...this.form,
      studioNames: this.studios
        .split(/\n|,/)
        .map((name) => name.trim())
        .filter(Boolean),
    };
    this.saving.set(true);
    this.api.save(settings).subscribe({
      next: (data) => {
        this.saving.set(false);
        this.show(data);
        this.notifications.success('Saved', data.blocked ?? 'Smaller copies uses the new rules.');
      },
      error: () => {
        this.saving.set(false);
        this.notifications.error("Couldn't save that", 'Check the numbers and try again.');
      },
    });
  }

  protected searchNow(): void {
    this.searching.set(true);
    this.api.searchNow().subscribe({
      next: (data) => {
        this.searching.set(false);
        this.data.set(data);
      },
      error: () => {
        this.searching.set(false);
        this.notifications.error("Couldn't search", 'Try again in a moment.');
      },
    });
  }

  protected isGrabbing(stashSceneId: string): boolean {
    return this.grabbing().has(stashSceneId);
  }

  protected grab(stashSceneId: string): void {
    if (this.grabbing().has(stashSceneId)) {
      return;
    }
    const done = () =>
      this.grabbing.update((set) => {
        const next = new Set(set);
        next.delete(stashSceneId);
        return next;
      });
    this.grabbing.update((set) => new Set(set).add(stashSceneId));
    this.api.grab(stashSceneId).subscribe({
      next: (data) => {
        done();
        this.data.set(data);
        this.notifications.success('Grabbed', 'Sent to SABnzbd.');
      },
      error: (error: { error?: { message?: string } }) => {
        done();
        this.notifications.error(
          "Couldn't grab it",
          error.error?.message ?? 'Try again in a moment.',
        );
      },
    });
  }

  private show(data: SmallerCopies): void {
    this.data.set(data);
    this.form = { ...data.settings };
    this.studios = data.settings.studioNames.join('\n');
  }
}
