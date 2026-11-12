import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  booleanAttribute,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FILTER_CHIP } from './filter-chip.component';

export interface FilterOption {
  id: string;
  label: string;
  /** How many scenes it'd give, when known. */
  count?: number | null;
  /** A heading it's listed under ("Recent", a studio network…). */
  group?: string | null;
}

/**
 * A filter's choices, ready to tap: a tick by what's picked, how many scenes
 * each gives, and a box to narrow a long list (never needed to see it).
 * One choice closes the list; with several allowed it stays open.
 */
@Component({
  selector: 'app-filter-options',
  template: `
    @if (searchable) {
      <label class="filter-search">
        <i class="pi pi-search" aria-hidden="true"></i>
        <span class="visually-hidden">{{ searchLabel }}</span>
        <input
          type="search"
          [placeholder]="searchLabel"
          [value]="query()"
          autocomplete="off"
          enterkeyhint="search"
          (input)="onType($any($event.target).value)"
        />
      </label>
    }

    <div class="filter-list" role="listbox" [attr.aria-multiselectable]="multi">
      @if (loading && shown().length === 0) {
        <p class="filter-note" role="status">Loading…</p>
      } @else if (shown().length === 0) {
        <p class="filter-note">{{ query() ? noMatchText : emptyText }}</p>
      }
      @for (option of shown(); track option.id; let i = $index) {
        @if (option.group && option.group !== shown()[i - 1]?.group) {
          <p class="filter-group">{{ option.group }}</p>
        }
        <button
          type="button"
          class="filter-option"
          role="option"
          [attr.aria-selected]="isPicked(option.id)"
          [attr.data-testid]="testId ? testId + '-' + option.id : null"
          (click)="pick(option.id)"
        >
          <span class="filter-option__label">{{ option.label }}</span>
          @if (option.count !== null && option.count !== undefined) {
            <span class="filter-option__count">{{ option.count }}</span>
          }
          <i
            class="pi pi-check filter-option__tick"
            [class.is-on]="isPicked(option.id)"
            aria-hidden="true"
          ></i>
        </button>
      }
    </div>

    @if (multi || (clearable && selected.length > 0)) {
      <div class="filter-foot">
        <button
          type="button"
          class="filter-foot__clear"
          [disabled]="selected.length === 0"
          (click)="clear()"
        >
          Clear
        </button>
        @if (multi) {
          <button type="button" class="filter-foot__done" (click)="done()">Done</button>
        }
      </div>
    }
  `,
  styleUrl: './filter-options.component.scss',
})
export class FilterOptionsComponent implements OnChanges {
  private readonly chip = inject(FILTER_CHIP, { optional: true });

  @Input() options: FilterOption[] = [];
  @Input() selected: string[] = [];
  /** Several at once (the list stays open); else one, and it closes. */
  @Input({ transform: booleanAttribute }) multi = false;
  @Input({ transform: booleanAttribute }) searchable = false;
  /** The parent looks typed words up itself (from the catalog). */
  @Input({ transform: booleanAttribute }) remote = false;
  @Input({ transform: booleanAttribute }) loading = false;
  /** A choice that can be taken off (not a sort, where one is always picked). */
  @Input({ transform: booleanAttribute }) clearable = true;
  @Input() searchLabel = 'Narrow the list';
  @Input() emptyText = 'Nothing to pick here.';
  @Input() noMatchText = 'Nothing by that name.';
  @Input() testId: string | null = null;

  /** The picked ids, after each change. */
  @Output() readonly changed = new EventEmitter<string[]>();
  /** What's typed, for a parent that looks it up (remote). */
  @Output() readonly searched = new EventEmitter<string>();

  protected readonly query = signal('');
  private readonly optionList = signal<FilterOption[]>([]);

  protected readonly shown = computed(() => {
    const list = this.optionList();
    const words = this.query().trim().toLowerCase();
    if (this.remote || !words) {
      return list;
    }
    return list.filter((option) => option.label.toLowerCase().includes(words));
  });

  ngOnChanges(): void {
    this.optionList.set(this.options ?? []);
  }

  protected isPicked(id: string): boolean {
    return this.selected.includes(id);
  }

  protected onType(value: string): void {
    this.query.set(value);
    if (this.remote) {
      this.searched.emit(value);
    }
  }

  protected pick(id: string): void {
    if (this.multi) {
      this.changed.emit(
        this.isPicked(id)
          ? this.selected.filter((picked) => picked !== id)
          : [...this.selected, id],
      );
      return;
    }
    this.changed.emit(this.isPicked(id) ? [] : [id]);
    this.chip?.close();
  }

  protected clear(): void {
    this.changed.emit([]);
    this.chip?.close();
  }

  protected done(): void {
    this.chip?.close();
  }
}
