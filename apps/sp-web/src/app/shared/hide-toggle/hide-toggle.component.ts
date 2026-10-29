import { Component, Input, OnInit, computed, inject, signal } from '@angular/core';
import { HiddenContentService, HiddenItemKind } from '../../core/api/hidden-content.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

const NOUN: Record<HiddenItemKind, string> = {
  tag: 'tag',
  studio: 'studio',
  performer: 'performer',
};

/**
 * "Hide this studio" (or performer, or tag): adds it to Settings → Hidden,
 * so its scenes leave every catalog list. Tapped again, it stops hiding.
 */
@Component({
  selector: 'app-hide-toggle',
  template: `
    @if (id()) {
      <button
        type="button"
        class="hide-toggle"
        [class.active]="hidden()"
        [disabled]="busy()"
        [attr.aria-pressed]="hidden()"
        [attr.aria-busy]="busy()"
        [attr.data-testid]="'hide-' + what()"
        (click)="toggle()"
      >
        <i
          class="pi"
          [class.pi-eye-slash]="!hidden()"
          [class.pi-eye]="hidden()"
          aria-hidden="true"
        ></i>
        <span>{{ label() }}</span>
      </button>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      max-width: 100%;
    }

    .hide-toggle {
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

    .hide-toggle:hover:not(:disabled) {
      color: var(--text-primary);
    }

    .hide-toggle span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hide-toggle.active {
      border-color: var(--tone-warning-border);
      background: var(--tone-warning-background);
      color: var(--tone-warning-text);
    }

    .hide-toggle:disabled {
      opacity: 0.6;
      cursor: default;
    }
  `,
})
export class HideToggleComponent implements OnInit {
  private readonly hiddenContent = inject(HiddenContentService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly what = signal<HiddenItemKind>('studio');
  protected readonly id = signal<string | null>(null);
  private readonly itemName = signal<string | null>(null);

  /** What it hides: a catalog tag, studio or performer. */
  @Input({ required: true }) set kind(value: HiddenItemKind) {
    this.what.set(value);
  }
  @Input() set itemId(value: string | null | undefined) {
    this.id.set(value?.trim() || null);
  }
  /** Shown in Settings → Hidden; the id stands in when it's missing. */
  @Input() set name(value: string | null | undefined) {
    this.itemName.set(value ?? null);
  }

  protected readonly busy = signal(false);
  protected readonly hidden = computed(() => this.hiddenContent.isHidden(this.what(), this.id()));
  protected readonly label = computed(() =>
    this.hidden() ? `Hidden · Show again` : `Hide this ${NOUN[this.what()]}`,
  );

  ngOnInit(): void {
    this.hiddenContent.ensureLoaded();
  }

  protected toggle(): void {
    const id = this.id();
    if (!id || this.busy()) {
      return;
    }
    const kind = this.what();
    const name = this.itemName()?.trim() || id;
    const wasHidden = this.hidden();
    this.busy.set(true);
    const request = wasHidden
      ? this.hiddenContent.unhide(kind, id)
      : this.hiddenContent.hide(kind, { id, name });
    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.notifications.success(
          wasHidden ? `Showing ${name} again` : `Hiding ${name}`,
          wasHidden
            ? 'Its scenes are back in your lists.'
            : 'Its scenes are left out of catalog lists. Settings → Hidden can undo this.',
        );
      },
      error: () => {
        this.busy.set(false);
        this.notifications.error(`Couldn’t update your hidden list`, 'Try again.');
      },
    });
  }
}
