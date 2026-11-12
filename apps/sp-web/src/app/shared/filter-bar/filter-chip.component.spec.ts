import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterChipComponent, FilterPanelDirective } from './filter-chip.component';
import { FilterOption, FilterOptionsComponent } from './filter-options.component';

@Component({
  imports: [FilterChipComponent, FilterPanelDirective, FilterOptionsComponent],
  template: `
    <app-filter-chip label="Category" [value]="value()" testId="cat">
      <ng-template appFilterPanel>
        <app-filter-options
          [options]="options"
          [selected]="picked()"
          [multi]="multi()"
          searchable
          testId="opt"
          (changed)="changed($event)"
        />
      </ng-template>
    </app-filter-chip>
    <button type="button" id="elsewhere">Elsewhere</button>
  `,
})
class HostComponent {
  readonly options: FilterOption[] = [
    { id: 'a', label: 'Outdoor', count: 40 },
    { id: 'b', label: 'POV', count: 12 },
    { id: 'c', label: 'Pool', count: 3 },
  ];
  readonly picked = signal<string[]>([]);
  readonly multi = signal(false);
  readonly value = signal<string | null>(null);
  readonly changed = vi.fn((ids: string[]) => this.picked.set(ids));
}

describe('FilterChipComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  async function render(phone = false) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: phone })),
    );
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(HostComponent);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const chip = root.querySelector('[data-testid="cat"]') as HTMLButtonElement;
    return { fixture, host: fixture.componentInstance, root, chip };
  }

  it('opens its choices at once, with counts, and one pick closes it', async () => {
    const { fixture, host, root, chip } = await render();
    expect(root.querySelector('.filter-dropdown')).toBeNull();

    chip.click();
    fixture.detectChanges();
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const rows = [...root.querySelectorAll('.filter-option')].map((row) =>
      row.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(rows).toEqual(['Outdoor40', 'POV12', 'Pool3']);

    (root.querySelector('[data-testid="opt-b"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.changed).toHaveBeenCalledWith(['b']);
    expect(root.querySelector('.filter-dropdown')).toBeNull();
  });

  it('stays open for several picks, and narrows the list as you type', async () => {
    const { fixture, host, root, chip } = await render();
    host.multi.set(true);
    chip.click();
    fixture.detectChanges();

    (root.querySelector('[data-testid="opt-a"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    (root.querySelector('[data-testid="opt-c"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.changed).toHaveBeenLastCalledWith(['a', 'c']);
    expect(root.querySelector('.filter-dropdown')).not.toBeNull();
    expect(root.querySelector('[data-testid="opt-a"]')?.getAttribute('aria-selected')).toBe('true');

    const search = root.querySelector('.filter-search input') as HTMLInputElement;
    search.value = 'po';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect([...root.querySelectorAll('.filter-option__label')].map((l) => l.textContent)).toEqual([
      'POV',
      'Pool',
    ]);

    (root.querySelector('.filter-foot__done') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('.filter-dropdown')).toBeNull();
  });

  it('closes on a tap elsewhere and on Escape', async () => {
    const { fixture, root, chip } = await render();
    chip.click();
    fixture.detectChanges();
    (root.querySelector('#elsewhere') as HTMLElement).dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );
    fixture.detectChanges();
    expect(root.querySelector('.filter-dropdown')).toBeNull();

    chip.click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(root.querySelector('.filter-dropdown')).toBeNull();
  });

  it('says what is picked, and on a phone opens a sheet instead', async () => {
    const { fixture, host, chip } = await render(true);
    host.value.set('Outdoor +1');
    fixture.detectChanges();
    expect(chip.textContent).toContain('Outdoor +1');
    expect(chip.classList).toContain('is-set');

    chip.click();
    fixture.detectChanges();
    const sheet = document.body.querySelector('[data-testid="cat-sheet"]');
    expect(sheet?.textContent).toContain('Category');
    expect(sheet?.querySelectorAll('.filter-option')).toHaveLength(3);
    fixture.destroy();
  });
});
