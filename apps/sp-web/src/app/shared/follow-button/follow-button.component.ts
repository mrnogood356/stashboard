import { Component, Input, OnChanges, inject, signal } from '@angular/core';
import { Follow, FollowKind, FollowsApiService } from '../../core/api/follows.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { FollowSheetComponent } from '../follow-sheet/follow-sheet.component';

const NOUN: Record<FollowKind, string> = { PERFORMER: 'performer', STUDIO: 'studio' };

/**
 * Follow a performer or studio from its page, a chip like "Hide this
 * performer" beside it. One tap follows, from today, with new scenes listed
 * for review; once followed, a tap opens its options. Not shown on a
 * secondary catalog's page, since only the main one is followed.
 */
@Component({
  selector: 'app-follow-button',
  imports: [FollowSheetComponent],
  template: `
    @if (followable()) {
      <button
        type="button"
        class="follow-toggle"
        [class.active]="follow() !== null"
        [disabled]="busy()"
        [attr.aria-pressed]="follow() !== null"
        [attr.aria-haspopup]="follow() !== null ? 'dialog' : null"
        [attr.aria-busy]="busy()"
        [attr.aria-label]="activeLabel()"
        data-testid="follow-toggle"
        (click)="toggle()"
      >
        <i
          class="pi"
          [class.pi-bell]="follow() === null"
          [class.pi-check]="follow() !== null"
          aria-hidden="true"
        ></i>
        <span>{{ follow() ? 'Following' : 'Follow' }}</span>
        @if (follow(); as current) {
          @if (current.newCount > 0) {
            <span class="count">{{ current.newCount }} new</span>
          }
        }
      </button>

      <app-follow-sheet
        [open]="sheetOpen()"
        [follow]="follow()"
        [imageUrl]="imageUrl ?? null"
        (closed)="sheetOpen.set(false)"
        (saved)="onSaved($event.follow)"
        (unfollowed)="onUnfollowed($event)"
      />
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      max-width: 100%;
    }

    /* The same chip as "Hide this performer" beside it. */
    .follow-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      max-width: 100%;
      min-height: 2.25rem;
      padding: 0.3rem 0.85rem;
      border-radius: 999px;
      border: 1px solid var(--border-strong);
      background: transparent;
      color: var(--text-secondary);
      font: inherit;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
    }

    .follow-toggle:hover:not(:disabled) {
      color: var(--text-primary);
    }

    .follow-toggle.active {
      border-color: color-mix(in srgb, var(--accent) 55%, transparent);
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      color: var(--accent-text, var(--accent));
    }

    .follow-toggle:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .count {
      font-weight: 500;
      opacity: 0.85;
    }

    .count::before {
      content: '·';
      margin-right: 0.4rem;
    }
  `,
})
export class FollowButtonComponent implements OnChanges {
  private readonly api = inject(FollowsApiService);
  private readonly notifications = inject(AppNotificationsService);

  @Input({ required: true }) kind!: FollowKind;
  @Input({ required: true }) entityId!: string | null | undefined;
  @Input() name: string | null | undefined;
  @Input() imageUrl: string | null | undefined;

  protected readonly follow = signal<Follow | null>(null);
  protected readonly followable = signal(false);
  protected readonly busy = signal(false);
  protected readonly sheetOpen = signal(false);
  /** Bumped on each lookup and follow, so a slower, older answer is ignored. */
  private generation = 0;

  protected label(): string {
    return this.name?.trim() || NOUN[this.kind];
  }

  /** Once following, says what the chip shows (with its count) and that it opens options. */
  protected activeLabel(): string | null {
    const current = this.follow();
    if (!current) {
      return null;
    }
    const count = current.newCount > 0 ? `, ${current.newCount} new` : '';
    return `Following ${this.label()}${count}: options`;
  }

  ngOnChanges(): void {
    const id = this.entityId?.trim();
    const generation = ++this.generation;
    this.follow.set(null);
    this.followable.set(false);
    this.sheetOpen.set(false);
    this.busy.set(false);
    if (!id) {
      return;
    }
    this.api.lookup(this.kind, id).subscribe({
      next: (result) => {
        if (generation === this.generation) {
          this.followable.set(result.followable);
          this.follow.set(result.follow);
        }
      },
      // Can't tell: leave the button out rather than offer one that fails.
      error: () => {
        if (generation === this.generation) {
          this.followable.set(false);
        }
      },
    });
  }

  protected toggle(): void {
    if (this.busy()) {
      return;
    }
    if (this.follow()) {
      this.sheetOpen.set(true);
      return;
    }
    const id = this.entityId?.trim();
    if (!id) {
      return;
    }
    const name = this.label();
    const generation = this.generation;
    this.busy.set(true);
    this.api
      .follow({ kind: this.kind, entityId: id, name, imageUrl: this.imageUrl ?? null })
      .subscribe({
        next: (follow) => {
          // This page shows someone else now: theirs isn't this follow.
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.follow.set(follow);
          this.notifications.success(
            `Following ${name}`,
            'New scenes will wait in Following. Tap Following for options.',
          );
        },
        error: () => {
          if (generation === this.generation) {
            this.busy.set(false);
          }
          this.notifications.error(`Couldn’t follow this ${NOUN[this.kind]}`, 'Try again.');
        },
      });
  }

  protected onSaved(follow: Follow): void {
    this.follow.set(follow);
    this.sheetOpen.set(false);
  }

  protected onUnfollowed(follow: Follow): void {
    this.follow.set(null);
    this.sheetOpen.set(false);
    this.notifications.success(`Stopped following ${follow.name}`);
  }
}
