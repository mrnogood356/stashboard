import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ContentChild,
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  InjectionToken,
  Input,
  Output,
  TemplateRef,
  booleanAttribute,
  inject,
  signal,
} from '@angular/core';
import { SheetComponent } from '../sheet/sheet.component';

/** What a chip's list is drawn from: `<ng-template appFilterPanel>…</ng-template>`. */
@Directive({ selector: 'ng-template[appFilterPanel]' })
export class FilterPanelDirective {
  readonly template = inject<TemplateRef<unknown>>(TemplateRef);
}

/** Lets what's in a chip's list close it once a choice is made. */
export interface FilterChipHandle {
  close(): void;
}
export const FILTER_CHIP = new InjectionToken<FilterChipHandle>('FILTER_CHIP');

/** A phone gets a sheet from the bottom; anything wider, a list under the chip. */
const PHONE_QUERY = '(max-width: 759px)';

/**
 * One filter in a filter bar: its name (or what's picked) on a chip, and
 * its choices straight away when tapped, with nothing more to open first.
 */
@Component({
  selector: 'app-filter-chip',
  imports: [NgTemplateOutlet, SheetComponent],
  providers: [{ provide: FILTER_CHIP, useExisting: FilterChipComponent }],
  template: `
    <button
      #chip
      type="button"
      class="filter-chip"
      [class.is-set]="!!value && !neutral"
      [class.is-open]="open()"
      aria-haspopup="dialog"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="value ? label + ': ' + value : label"
      [attr.data-testid]="testId"
      (click)="toggle()"
    >
      <span class="filter-chip__text">{{ value || label }}</span>
      <i class="pi pi-chevron-down" aria-hidden="true"></i>
    </button>

    @if (open() && !phone()) {
      <div
        class="filter-dropdown"
        [class.filter-dropdown--end]="alignEnd()"
        [style.max-height.px]="maxHeight()"
        role="dialog"
        [attr.aria-label]="label"
      >
        <ng-container [ngTemplateOutlet]="panel?.template ?? null" />
      </div>
    }

    <app-sheet
      [open]="open() && phone()"
      [title]="label"
      scroll="own"
      [testId]="testId ? testId + '-sheet' : null"
      (closed)="close()"
    >
      @if (open() && phone()) {
        <div class="filter-sheet-body">
          <ng-container [ngTemplateOutlet]="panel?.template ?? null" />
        </div>
      }
    </app-sheet>
  `,
  styleUrl: './filter-chip.component.scss',
})
export class FilterChipComponent implements FilterChipHandle {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** What it filters by: "Category", "Studio", "Sort". */
  @Input({ required: true }) label = '';
  /** What's picked, said on the chip in place of the label ("Outdoor +1"). */
  @Input() value: string | null = null;
  @Input() testId: string | null = null;
  /** Says its value without looking set (a sort, where something always is). */
  @Input({ transform: booleanAttribute }) neutral = false;
  @Output() readonly opened = new EventEmitter<void>();

  @ContentChild(FilterPanelDirective) protected panel?: FilterPanelDirective;

  protected readonly open = signal(false);
  protected readonly phone = signal(false);
  /** Near the right edge, the list opens leftwards so it stays on screen. */
  protected readonly alignEnd = signal(false);
  /** As tall as the room under the chip allows. */
  protected readonly maxHeight = signal(416);

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    const view = this.host.nativeElement.ownerDocument.defaultView;
    this.phone.set(view?.matchMedia?.(PHONE_QUERY).matches ?? false);
    const rect = this.host.nativeElement.getBoundingClientRect();
    this.alignEnd.set(!!view && rect.left + 336 > view.innerWidth);
    if (view) {
      this.maxHeight.set(Math.max(220, Math.min(416, view.innerHeight - rect.bottom - 20)));
    }
    this.open.set(true);
    this.opened.emit();
  }

  close(): void {
    // Closed from inside the list under the chip (an option, Clear, Done):
    // focus goes back to the chip, not to the top of the page. A sheet on a
    // phone puts it back itself; a click elsewhere leaves focus there.
    const host = this.host.nativeElement;
    const focused = host.ownerDocument.activeElement;
    const fromInside =
      this.open() && !this.phone() && !!focused && focused !== host && host.contains(focused);
    this.open.set(false);
    if (fromInside) {
      (host.querySelector('.filter-chip') as HTMLElement | null)?.focus();
    }
  }

  /** A tap or click anywhere else closes the list under the chip. */
  @HostListener('document:pointerdown', ['$event'])
  protected onOutside(event: Event): void {
    if (!this.open() || this.phone()) {
      return;
    }
    const target = event.target as Node | null;
    if (target && !this.host.nativeElement.contains(target)) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    // The sheet handles its own; this is for the list under the chip.
    if (this.open() && !this.phone() && !event.defaultPrevented) {
      event.preventDefault();
      this.close();
      (this.host.nativeElement.querySelector('.filter-chip') as HTMLElement | null)?.focus();
    }
  }
}
