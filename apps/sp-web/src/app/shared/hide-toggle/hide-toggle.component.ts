import { Component, ElementRef, Input, OnInit, computed, inject, signal } from '@angular/core';
import { HiddenContentService, HiddenItemKind } from '../../core/api/hidden-content.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

let nextPanelId = 0;

const NOUN: Record<HiddenItemKind, string> = {
  tag: 'tag',
  studio: 'studio',
  performer: 'performer',
};

/**
 * "Hide this studio" (or performer, or tag), in a ⋯ menu: adds it to
 * Settings → Hidden, so its scenes leave every catalog list. Once hidden it
 * says so in plain sight, and a tap there stops hiding it.
 */
@Component({
  selector: 'app-hide-toggle',
  host: {
    '(document:click)': 'closeOnOutsideClick($event)',
    '(document:keydown.escape)': 'closeOnEscape()',
  },
  template: `
    @if (id()) {
      @if (hidden()) {
        <!-- Hidden: said plainly, with the way back one tap away. -->
        <button
          type="button"
          class="hide-toggle active"
          [disabled]="busy()"
          aria-pressed="true"
          [attr.aria-busy]="busy()"
          [attr.data-testid]="'hide-' + what()"
          (click)="toggle()"
        >
          <i class="pi pi-eye" aria-hidden="true"></i>
          <span>Hidden · Show again</span>
        </button>
      } @else {
        <!-- Rarely wanted, so it waits in a menu instead of beside the main actions. -->
        <div class="hide-menu">
          <button
            type="button"
            class="hide-menu-trigger"
            [attr.aria-label]="'More options for this ' + noun()"
            [attr.aria-expanded]="menuOpen()"
            [attr.aria-controls]="panelId"
            [attr.data-testid]="'more-' + what()"
            (click)="toggleMenu($event)"
          >
            <i class="pi pi-ellipsis-h" aria-hidden="true"></i>
          </button>
          @if (menuOpen()) {
            <ul class="hide-menu-list" [id]="panelId">
              <li>
                <button
                  type="button"
                  [disabled]="busy()"
                  aria-pressed="false"
                  [attr.aria-busy]="busy()"
                  [attr.data-testid]="'hide-' + what()"
                  (click)="toggle()"
                >
                  <i class="pi pi-eye-slash" aria-hidden="true"></i>
                  <span>
                    Hide this {{ noun() }}
                    <small>Its scenes leave your catalog lists.</small>
                  </span>
                </button>
              </li>
            </ul>
          }
        </div>
      }
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
      border-radius: var(--radius-sm);
      border: 1px solid var(--tone-warning-border);
      background: var(--tone-warning-background);
      color: var(--tone-warning-text);
      font: inherit;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
    }

    .hide-toggle span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hide-toggle:disabled,
    .hide-menu-list button:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .hide-menu {
      position: relative;
    }

    .hide-menu-trigger {
      display: grid;
      place-items: center;
      width: 2.25rem;
      height: 2.25rem;
      padding: 0;
      border: 1px solid var(--border-subtle);
      border-radius: 50%;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .hide-menu-trigger:hover {
      color: var(--text-primary);
    }

    .hide-menu-list {
      position: absolute;
      top: calc(100% + 0.35rem);
      left: 0;
      z-index: 20;
      min-width: 15rem;
      margin: 0;
      padding: 0.3rem;
      list-style: none;
      border-radius: 14px;
      background: color-mix(in srgb, var(--surface-1) 94%, transparent);
      backdrop-filter: var(--glass-blur, blur(20px));
      -webkit-backdrop-filter: var(--glass-blur, blur(20px));
      box-shadow: 0 14px 34px rgb(0 0 0 / 35%);
      text-align: left;
    }

    .hide-menu-list button {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      width: 100%;
      padding: 0.6rem 0.7rem;
      border: 0;
      border-radius: 9px;
      background: none;
      color: var(--text-primary);
      font: inherit;
      font-size: 0.88rem;
      text-align: left;
      cursor: pointer;
    }

    .hide-menu-list button i {
      margin-top: 0.15rem;
    }

    .hide-menu-list button:hover:not(:disabled) {
      background: var(--chip-bg);
    }

    .hide-menu-list small {
      display: block;
      margin-top: 0.1rem;
      color: var(--text-secondary);
      font-size: 0.78rem;
    }
  `,
})
export class HideToggleComponent implements OnInit {
  private readonly hiddenContent = inject(HiddenContentService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
  protected readonly menuOpen = signal(false);
  protected readonly hidden = computed(() => this.hiddenContent.isHidden(this.what(), this.id()));
  protected readonly noun = computed(() => NOUN[this.what()]);
  /** A plain disclosure: the ⋯ button shows or hides one button under it. */
  protected readonly panelId = `hide-options-${++nextPanelId}`;

  ngOnInit(): void {
    this.hiddenContent.ensureLoaded();
  }

  protected toggleMenu(event: Event): void {
    event.stopPropagation();
    this.menuOpen.update((open) => !open);
  }

  protected closeOnOutsideClick(event: Event): void {
    if (this.menuOpen() && !this.host.nativeElement.contains(event.target as Node | null)) {
      this.menuOpen.set(false);
    }
  }

  protected closeOnEscape(): void {
    if (!this.menuOpen()) {
      return;
    }
    this.menuOpen.set(false);
    this.host.nativeElement.querySelector<HTMLElement>('.hide-menu-trigger')?.focus();
  }

  protected toggle(): void {
    const id = this.id();
    if (!id || this.busy()) {
      return;
    }
    const kind = this.what();
    const name = this.itemName()?.trim() || id;
    const wasHidden = this.hidden();
    this.menuOpen.set(false);
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
