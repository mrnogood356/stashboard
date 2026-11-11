import { Component, Input, OnChanges, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  Follow,
  FollowKind,
  FollowsApiService,
  SINCE_OPTIONS,
  sinceDaysAgo,
  sinceOptionFor,
} from '../../core/api/follows.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

const NOUN: Record<FollowKind, string> = { PERFORMER: 'performer', STUDIO: 'studio' };

/**
 * Follow a performer or studio from its page. Following starts at once, from
 * today, with new scenes listed for review; the options under it change how
 * far back it reaches, request new scenes automatically, or unfollow. Not
 * shown on a secondary catalog's page, since only the main one is followed.
 */
@Component({
  selector: 'app-follow-button',
  imports: [RouterLink],
  template: `
    @if (followable()) {
      <button
        type="button"
        class="follow-toggle"
        [class.active]="follow() !== null"
        [disabled]="busy()"
        [attr.aria-pressed]="follow() !== null"
        [attr.aria-expanded]="follow() !== null ? open() : null"
        [attr.aria-busy]="busy()"
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
            <span class="count" [attr.aria-label]="current.newCount + ' new'">{{
              current.newCount
            }}</span>
          }
          <i
            class="pi chevron"
            [class.pi-chevron-down]="!open()"
            [class.pi-chevron-up]="open()"
            aria-hidden="true"
          ></i>
        }
      </button>

      @if (open() && follow(); as current) {
        <div
          class="follow-panel"
          role="group"
          aria-label="Following options"
          data-testid="follow-panel"
        >
          <label class="field">
            <span>Show scenes from</span>
            <select
              [value]="sinceChoice()"
              [disabled]="busy()"
              data-testid="follow-since"
              (change)="setSince($any($event.target).value)"
            >
              @for (option of sinceOptions; track option.days) {
                <option [value]="option.days">{{ option.label }}</option>
              }
            </select>
          </label>
          <label class="check">
            <input
              type="checkbox"
              [checked]="current.autoRequest"
              [disabled]="busy()"
              data-testid="follow-auto"
              (change)="setAutoRequest($any($event.target).checked)"
            />
            <span>
              Request new scenes automatically
              <small>Otherwise they wait in Following for you to choose.</small>
            </span>
          </label>
          <div class="panel-actions">
            <a routerLink="/following" class="link">Open Following</a>
            <button
              type="button"
              class="unfollow"
              [disabled]="busy()"
              data-testid="unfollow"
              (click)="unfollow()"
            >
              Unfollow
            </button>
          </div>
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: contents;
    }

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

    .chevron {
      font-size: 0.7rem;
    }

    .count {
      min-width: 1.25rem;
      padding: 0 0.35rem;
      border-radius: 999px;
      background: var(--accent);
      color: var(--accent-contrast, #fff);
      font-size: 0.72rem;
      line-height: 1.25rem;
      text-align: center;
    }

    .follow-panel {
      flex-basis: 100%;
      display: grid;
      gap: 0.7rem;
      max-width: 26rem;
      padding: 0.8rem 0.9rem;
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      background: var(--surface-1);
      text-align: left;
      font-size: 0.88rem;
    }

    .field {
      display: grid;
      gap: 0.3rem;
      color: var(--text-secondary);
    }

    .field select {
      min-height: 2.25rem;
      padding: 0 0.6rem;
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      background: var(--surface-elevated, var(--surface-1));
      color: var(--text-primary);
      font: inherit;
    }

    .check {
      display: flex;
      align-items: flex-start;
      gap: 0.55rem;
      cursor: pointer;
    }

    .check input {
      margin-top: 0.2rem;
    }

    .check small {
      display: block;
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    .panel-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .link {
      color: var(--accent-text, var(--accent));
      font-weight: 600;
      text-decoration: none;
    }

    .unfollow {
      min-height: 2rem;
      border: 0;
      background: none;
      padding: 0.3rem 0;
      color: var(--tone-danger-text, var(--text-secondary));
      font: inherit;
      font-weight: 600;
      cursor: pointer;
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
  protected readonly open = signal(false);
  protected readonly sinceChoice = signal<number>(0);
  protected readonly sinceOptions = SINCE_OPTIONS;

  ngOnChanges(): void {
    const id = this.entityId?.trim();
    this.follow.set(null);
    this.followable.set(false);
    this.open.set(false);
    if (!id) {
      return;
    }
    this.api.lookup(this.kind, id).subscribe({
      next: (result) => {
        if (this.entityId?.trim() !== id) {
          return;
        }
        this.followable.set(result.followable);
        this.setFollow(result.follow);
      },
      // Can't tell: leave the button out rather than offer one that fails.
      error: () => this.followable.set(false),
    });
  }

  protected toggle(): void {
    if (this.busy()) {
      return;
    }
    if (this.follow()) {
      this.open.update((open) => !open);
      return;
    }
    const id = this.entityId?.trim();
    if (!id) {
      return;
    }
    const name = this.name?.trim() || id;
    this.busy.set(true);
    this.api
      .follow({ kind: this.kind, entityId: id, name, imageUrl: this.imageUrl ?? null })
      .subscribe({
        next: (follow) => {
          this.busy.set(false);
          this.setFollow(follow);
          this.open.set(true);
          this.notifications.success(
            `Following ${name}`,
            'Their new scenes will wait in Following for you.',
          );
        },
        error: () => {
          this.busy.set(false);
          this.notifications.error(`Couldn’t follow this ${NOUN[this.kind]}`, 'Try again.');
        },
      });
  }

  protected setSince(value: string): void {
    const days = Number(value);
    this.save({ since: sinceDaysAgo(Number.isFinite(days) ? days : 0) }, () =>
      this.sinceChoice.set(days),
    );
  }

  protected setAutoRequest(autoRequest: boolean): void {
    this.save({ autoRequest });
  }

  protected unfollow(): void {
    const current = this.follow();
    if (!current || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.api.unfollow(current.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.open.set(false);
        this.follow.set(null);
        this.notifications.success(`Stopped following ${current.name}`);
      },
      error: () => {
        this.busy.set(false);
        this.notifications.error('Couldn’t unfollow', 'Try again.');
      },
    });
  }

  private save(changes: { since?: string; autoRequest?: boolean }, done?: () => void): void {
    const current = this.follow();
    if (!current || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.api.update(current.id, changes).subscribe({
      next: (follow) => {
        this.busy.set(false);
        this.follow.set(follow);
        done?.();
      },
      error: () => {
        this.busy.set(false);
        // Put the controls back the way they were.
        this.setFollow({ ...current });
        this.notifications.error('Couldn’t save that', 'Try again.');
      },
    });
  }

  private setFollow(follow: Follow | null): void {
    this.follow.set(follow);
    this.sinceChoice.set(follow ? sinceOptionFor(follow.since, follow.createdAt) : 0);
  }
}
