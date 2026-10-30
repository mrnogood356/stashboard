import {
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDropList,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { finalize, switchMap } from 'rxjs';
import { HomeService } from '../../core/api/home.service';
import {
  DEFAULT_HOME_ROW_DISPLAY,
  HomeRailConfig,
  HomeRailItem,
  HomeRowDisplay,
  HomeRowGalleryItem,
} from '../../core/api/home.types';

const COUNT_OPTIONS = [6, 8, 10, 12, 16, 20, 24, 30];

const FROM_LABEL: Record<HomeRowGalleryItem['from'], string> = {
  library: 'Your library',
  catalog: 'Catalog',
  whisparr: 'Whisparr',
  requests: 'Requests',
};

const SORT_LABEL: Record<string, string> = {
  DATE: 'newest releases',
  TRENDING: 'trending',
  TITLE: 'A–Z',
  CREATED_AT: 'newest added',
  UPDATED_AT: 'recently changed',
};

/**
 * Customize Home: the rows in order, each with an on/off switch, drag to
 * reorder, and how it looks; plus a gallery of ready-made rows. Every change
 * saves at once and is handed back to the page, so Home updates behind the
 * sheet. Rows of your own are built in the page's filter form, shown here
 * through the projected content.
 */
@Component({
  selector: 'app-home-rows-editor',
  imports: [CdkDropList, CdkDrag, CdkDragHandle],
  templateUrl: './home-rows-editor.component.html',
  styleUrl: './home-rows-editor.component.scss',
})
export class HomeRowsEditorComponent implements OnChanges {
  private readonly homeService = inject(HomeService);

  /** Every row, shown or not, in Home order. */
  @Input({ required: true }) rows: HomeRailConfig[] = [];
  /** Scenes already loaded for each row, for the little previews. */
  @Input() previews: Record<string, HomeRailItem[]> = {};
  /** The page's filter form is open (building or editing a row of your own). */
  @Input() formOpen = false;

  @Output() readonly closed = new EventEmitter<void>();
  /** The rows after a change of order, a switch, an add or a removal. */
  @Output() readonly rowsChanged = new EventEmitter<HomeRailConfig[]>();
  /** One row after a change to how it looks. */
  @Output() readonly rowChanged = new EventEmitter<HomeRailConfig>();
  @Output() readonly editFilters = new EventEmitter<HomeRailConfig>();
  @Output() readonly buildOwn = new EventEmitter<void>();

  protected readonly order = signal<HomeRailConfig[]>([]);
  protected readonly view = signal<'rows' | 'gallery'>('rows');
  protected readonly openRowId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly gallery = signal<HomeRowGalleryItem[] | null>(null);
  protected readonly galleryError = signal(false);
  protected readonly adding = signal<string | null>(null);
  protected readonly countOptions = COUNT_OPTIONS;
  protected readonly shownCount = computed(() => this.order().filter((row) => row.enabled).length);
  protected readonly galleryGroups = computed(() => {
    const items = this.gallery() ?? [];
    return (['library', 'catalog', 'whisparr', 'requests'] as const)
      .map((from) => ({ label: FROM_LABEL[from], items: items.filter((i) => i.from === from) }))
      .filter((group) => group.items.length > 0);
  });

  ngOnChanges(): void {
    this.order.set([...this.rows]);
  }

  protected display(row: HomeRailConfig): HomeRowDisplay {
    return { ...DEFAULT_HOME_ROW_DISPLAY, ...(row.display ?? {}) };
  }

  /** Where the row's scenes come from and how it picks them, in words. */
  protected describe(row: HomeRailConfig): string {
    const from =
      row.key === 'COMING_SOON'
        ? 'Whisparr'
        : row.key === 'STILL_WAITING'
          ? 'Requests'
          : row.source === 'STASH'
            ? 'Your library'
            : 'Catalog';
    const parts = [from];
    if (row.kind === 'CUSTOM') {
      parts.push(SORT_LABEL[row.config.sort] ?? row.config.sort.toLowerCase());
      const filters = row.config.tagIds.length + row.config.studioIds.length;
      if (filters > 0) {
        parts.push(`${filters} filter${filters === 1 ? '' : 's'}`);
      }
    }
    parts.push(`${this.display(row).limit ?? row.config.limit} scenes`);
    return parts.join(' · ');
  }

  protected preview(row: HomeRailConfig): HomeRailItem[] {
    return (this.previews[row.id] ?? []).slice(0, 4);
  }

  // ---------- order and switches: saved at once ----------

  protected setShown(row: HomeRailConfig, enabled: boolean): void {
    this.saveOrder(this.order().map((r) => (r.id === row.id ? { ...r, enabled } : r)));
  }

  protected drop(event: CdkDragDrop<HomeRailConfig[]>): void {
    if (event.previousIndex === event.currentIndex) {
      return;
    }
    const next = [...this.order()];
    moveItemInArray(next, event.previousIndex, event.currentIndex);
    this.saveOrder(next);
  }

  /** The keyboard way to reorder (and a fallback to dragging). */
  protected move(index: number, by: -1 | 1): void {
    const target = index + by;
    const next = [...this.order()];
    if (target < 0 || target >= next.length) {
      return;
    }
    moveItemInArray(next, index, target);
    this.saveOrder(next);
  }

  private saveOrder(next: HomeRailConfig[]): void {
    const before = this.order();
    this.order.set(next);
    this.saving.set(true);
    this.error.set(null);
    this.homeService
      .updateRails({ rails: next.map((row) => ({ id: row.id, enabled: row.enabled })) })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (rows) => this.rowsChanged.emit(rows),
        error: () => {
          this.order.set(before);
          this.error.set('Couldn’t save that change. Try again.');
        },
      });
  }

  // ---------- one row's look ----------

  protected toggleOpen(row: HomeRailConfig): void {
    this.openRowId.update((id) => (id === row.id ? null : row.id));
  }

  protected setDisplay(row: HomeRailConfig, change: Partial<HomeRowDisplay>): void {
    // Shown at once; the server's answer replaces it.
    const optimistic = { ...row, display: { ...this.display(row), ...change } };
    this.order.update((rows) => rows.map((r) => (r.id === row.id ? optimistic : r)));
    this.homeService.updateRowDisplay(row.id, change).subscribe({
      next: (saved) => {
        this.order.update((rows) => rows.map((r) => (r.id === saved.id ? saved : r)));
        this.rowChanged.emit(saved);
      },
      error: () => {
        this.order.update((rows) => rows.map((r) => (r.id === row.id ? row : r)));
        this.error.set('Couldn’t save that change. Try again.');
      },
    });
  }

  protected rename(row: HomeRailConfig, value: string): void {
    const title = value.trim();
    if (title === row.title) {
      return;
    }
    this.setDisplay(row, { title: title || null });
  }

  protected setCount(row: HomeRailConfig, value: string): void {
    const count = Number(value);
    this.setDisplay(row, { limit: count === row.config.limit ? null : count });
  }

  protected remove(row: HomeRailConfig): void {
    if (!window.confirm(`Remove “${row.title}” from Home?`)) {
      return;
    }
    this.saving.set(true);
    this.homeService
      .deleteRail(row.id)
      .pipe(
        switchMap(() => this.homeService.getRails()),
        finalize(() => this.saving.set(false)),
      )
      .subscribe({
        next: (rows) => {
          this.openRowId.set(null);
          this.rowsChanged.emit(rows);
        },
        error: () => this.error.set('Couldn’t remove that row. Try again.'),
      });
  }

  // ---------- adding rows ----------

  protected openGallery(): void {
    this.view.set('gallery');
    this.galleryError.set(false);
    this.homeService.getRowGallery().subscribe({
      next: (items) => this.gallery.set(items),
      error: () => this.galleryError.set(true),
    });
  }

  protected add(item: HomeRowGalleryItem): void {
    this.adding.set(item.id);
    this.homeService
      .addGalleryRow(item.id)
      .pipe(
        switchMap(() => this.homeService.getRails()),
        finalize(() => this.adding.set(null)),
      )
      .subscribe({
        next: (rows) => {
          this.rowsChanged.emit(rows);
          if (!item.repeatable) {
            this.gallery.update(
              (items) => items?.map((i) => (i.id === item.id ? { ...i, added: true } : i)) ?? null,
            );
          }
          this.view.set('rows');
        },
        error: (error: unknown) => this.error.set(messageFrom(error, 'Couldn’t add that row.')),
      });
  }

  protected startOwn(): void {
    this.view.set('rows');
    this.buildOwn.emit();
  }
}

function messageFrom(error: unknown, fallback: string): string {
  const message =
    error instanceof HttpErrorResponse
      ? (error.error as { message?: unknown } | null)?.message
      : null;
  return typeof message === 'string' && message ? message : fallback;
}
