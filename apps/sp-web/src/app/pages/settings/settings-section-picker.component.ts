import {
  Component,
  DestroyRef,
  ElementRef,
  Input,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import { SettingsNavItem, groupSettingsNav } from './settings-nav';

let nextId = 0;

/**
 * The Settings section switcher: a button naming the current section that
 * opens a grouped list of every section. A row of tabs no longer fits, even on
 * a desktop window, so this works the same at every width.
 *
 * It follows the disclosure-navigation pattern (a button with aria-expanded
 * controlling a <nav> of links) rather than role="menu", so links stay links.
 * Arrow keys, Home and End move between them; Escape, a click outside or
 * tabbing away closes it.
 */
@Component({
  selector: 'app-settings-section-picker',
  imports: [RouterLink],
  templateUrl: './settings-section-picker.component.html',
  styleUrl: './settings-section-picker.component.scss',
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(focusout)': 'onFocusOut($event)',
    '(keydown.escape)': 'onEscape($event)',
    '(keydown)': 'onPanelKeydown($event)',
  },
})
export class SettingsSectionPickerComponent {
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Signal-backed so the groups and current section recompute. */
  @Input({ required: true }) set items(value: readonly SettingsNavItem[]) {
    this.itemList.set(value);
  }
  private readonly itemList = signal<readonly SettingsNavItem[]>([]);

  protected readonly panelId = `settings-section-menu-${nextId++}`;
  protected readonly open = signal(false);
  protected readonly groups = computed(() => groupSettingsNav(this.itemList()));

  @ViewChild('trigger', { static: true }) private trigger!: ElementRef<HTMLButtonElement>;
  @ViewChild('panel') private panel?: ElementRef<HTMLElement>;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected readonly active = computed(() => {
    this.url();
    return (
      this.itemList().find((item) =>
        this.router.isActive(item.route, {
          paths: (item.exact ?? true) ? 'exact' : 'subset',
          queryParams: 'ignored',
          fragment: 'ignored',
          matrixParams: 'ignored',
        }),
      ) ?? null
    );
  });

  protected readonly activeGroupLabel = computed(() => {
    const active = this.active();
    return this.groups().find((group) => group.items.includes(active!))?.label ?? 'Section';
  });

  constructor() {
    // Picking a section (or Back/Forward) closes the list.
    const subscription = this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => this.open.set(false));
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }

  protected toggle(): void {
    if (this.open()) {
      this.close(false);
    } else {
      this.show('active');
    }
  }

  protected onTriggerKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.show(event.key === 'ArrowDown' ? 'active' : 'last');
    }
  }

  /** Arrow keys, Home and End inside the open list. */
  protected onPanelKeydown(event: KeyboardEvent): void {
    if (!this.panel?.nativeElement.contains(event.target as Node)) {
      return;
    }
    const links = this.links();
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : (index + 1) % links.length;
        break;
      case 'ArrowUp':
        next = index <= 0 ? links.length - 1 : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = links.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    links[next]?.focus();
  }

  protected onEscape(event: Event): void {
    if (this.open()) {
      event.preventDefault();
      this.close(true);
    }
  }

  /** Tabbing out of the button and list closes it. */
  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (this.open() && next && !this.host.nativeElement.contains(next)) {
      this.close(false);
    }
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.close(false);
    }
  }

  protected onLinkClick(): void {
    this.close(true);
  }

  private show(focus: 'active' | 'last'): void {
    this.open.set(true);
    // The list renders on the next change detection; focus it after that.
    setTimeout(() => {
      const links = this.links();
      const current = links.find((link) => link.getAttribute('aria-current') === 'page');
      (focus === 'last' ? links[links.length - 1] : (current ?? links[0]))?.focus();
    });
  }

  private close(returnFocus: boolean): void {
    this.open.set(false);
    if (returnFocus) {
      this.trigger.nativeElement.focus();
    }
  }

  private links(): HTMLAnchorElement[] {
    return Array.from(
      this.panel?.nativeElement.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [],
    );
  }
}
