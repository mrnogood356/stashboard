import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeService } from '../../core/api/home.service';
import { HomeRailConfig } from '../../core/api/home.types';
import { HomeRowsEditorComponent } from './home-rows-editor.component';

function row(id: string, overrides: Partial<HomeRailConfig> = {}): HomeRailConfig {
  return {
    id,
    key: null,
    kind: 'BUILTIN',
    source: 'STASH',
    contentType: 'SCENES',
    title: `Row ${id}`,
    subtitle: null,
    enabled: true,
    sortOrder: 0,
    editable: false,
    deletable: false,
    config: {
      sort: 'CREATED_AT',
      direction: 'DESC',
      titleQuery: null,
      tagIds: [],
      tagNames: [],
      tagMode: null,
      studioIds: [],
      studioNames: [],
      favoritePerformersOnly: false,
      favoriteStudiosOnly: false,
      favoriteTagsOnly: false,
      limit: 16,
    },
    ...overrides,
  } as HomeRailConfig;
}

describe('HomeRowsEditorComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  async function render(service: Partial<Record<keyof HomeService, unknown>>) {
    await TestBed.configureTestingModule({
      imports: [HomeRowsEditorComponent],
      providers: [{ provide: HomeService, useValue: service }],
    }).compileComponents();
    const fixture = TestBed.createComponent(HomeRowsEditorComponent);
    fixture.componentRef.setInput('rows', [row('a'), row('b', { enabled: false }), row('c')]);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('lists every row and says how many are shown', async () => {
    const { root } = await render({});
    expect(root.textContent).toContain('2 of 3 rows shown');
    expect(root.querySelectorAll('[data-testid^="row-"]').length).toBe(3);
    expect(root.textContent).toContain('Your library · 16 scenes');
  });

  it('saves a switch at once and hands the rows back', async () => {
    const saved = [row('a'), row('b'), row('c')];
    const updateRails = vi.fn().mockReturnValue(of(saved));
    const { fixture, root } = await render({ updateRails });
    const changed = vi.fn();
    fixture.componentInstance.rowsChanged.subscribe(changed);

    const toggle = root.querySelector(
      '[data-testid="row-b"] input[role="switch"]',
    ) as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    expect(updateRails).toHaveBeenCalledWith({
      rails: [
        { id: 'a', enabled: true },
        { id: 'b', enabled: true },
        { id: 'c', enabled: true },
      ],
    });
    expect(changed).toHaveBeenCalledWith(saved);
  });

  it('moves a row down with the keyboard buttons', async () => {
    const updateRails = vi.fn().mockReturnValue(of([]));
    const { root } = await render({ updateRails });

    (root.querySelector('[aria-label="Move Row a down"]') as HTMLButtonElement).click();

    expect(updateRails.mock.calls[0][0].rails.map((r: { id: string }) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('changes how a row looks: style, details and its own name', async () => {
    const updateRowDisplay = vi
      .fn()
      .mockImplementation((id: string, change: object) =>
        of({ ...row(id), display: { ...change } }),
      );
    const { fixture, root } = await render({ updateRowDisplay });
    const changed = vi.fn();
    fixture.componentInstance.rowChanged.subscribe(changed);

    (root.querySelector('[aria-label="Change how Row a looks"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const settings = root.querySelector('[data-testid="row-settings"]') as HTMLElement;

    Array.from(settings.querySelectorAll('button[role="radio"]'))
      .find((b) => b.textContent?.includes('Poster'))!
      .dispatchEvent(new Event('click'));
    const length = Array.from(settings.querySelectorAll('label.chip'))
      .find((l) => l.textContent?.includes('Length'))!
      .querySelector('input') as HTMLInputElement;
    length.checked = true;
    length.dispatchEvent(new Event('change'));
    const name = settings.querySelector('input[type="text"]') as HTMLInputElement;
    name.value = 'Fresh';
    name.dispatchEvent(new Event('change'));

    expect(updateRowDisplay).toHaveBeenCalledWith('a', { style: 'poster' });
    expect(updateRowDisplay).toHaveBeenCalledWith('a', { showDuration: true });
    expect(updateRowDisplay).toHaveBeenCalledWith('a', { title: 'Fresh' });
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('adds a ready-made row from the gallery', async () => {
    const getRowGallery = vi.fn().mockReturnValue(
      of([
        {
          id: 'TOP_RATED',
          title: 'Top Rated',
          description: 'Your highest-rated scenes.',
          from: 'library',
          added: false,
          repeatable: false,
        },
        {
          id: 'CONTINUE_WATCHING',
          title: 'Continue Watching',
          description: 'Pick up where you left off.',
          from: 'library',
          added: true,
          repeatable: false,
        },
      ]),
    );
    const addGalleryRow = vi.fn().mockReturnValue(of(row('new')));
    const rows = [row('a'), row('new')];
    const getRails = vi.fn().mockReturnValue(of(rows));
    const { fixture, root } = await render({ getRowGallery, addGalleryRow, getRails });
    const changed = vi.fn();
    fixture.componentInstance.rowsChanged.subscribe(changed);

    (root.querySelector('[data-testid="add-row"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="gallery-CONTINUE_WATCHING"]')?.textContent).toContain(
      'On Home',
    );
    (root.querySelector('[aria-label="Add Top Rated"]') as HTMLButtonElement).click();

    expect(addGalleryRow).toHaveBeenCalledWith('TOP_RATED');
    expect(changed).toHaveBeenCalledWith(rows);
  });

  it('removes a removable row after asking', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteRail = vi.fn().mockReturnValue(of(undefined));
    const getRails = vi.fn().mockReturnValue(of([row('a')]));
    const { fixture, root } = await render({ deleteRail, getRails });
    fixture.componentRef.setInput('rows', [
      row('a'),
      row('x', { deletable: true, editable: true, kind: 'CUSTOM' }),
    ]);
    fixture.detectChanges();

    (root.querySelector('[aria-label="Change how Row x looks"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    Array.from(root.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Remove'))!
      .click();

    expect(deleteRail).toHaveBeenCalledWith('x');
  });
});
