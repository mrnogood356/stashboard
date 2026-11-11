import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../../core/api/discover.service';
import { StudioPerformersComponent } from './studio-performers.component';

const performer = (id: string, name: string) => ({
  id,
  name,
  gender: null,
  sceneCount: 3,
  isFavorite: false,
  imageUrl: null,
  cardImageUrl: null,
});

async function render() {
  const getPerformersFeed = vi.fn((page: number, _per: number, filters: { name?: string }) =>
    of({
      total: filters.name ? 1 : 30,
      page,
      perPage: 24,
      hasMore: !filters.name && page === 1,
      items: filters.name
        ? [performer('k', 'Khloe Kingsley')]
        : [performer(`p${page}`, `Performer ${page}`)],
    }),
  );
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [StudioPerformersComponent],
    providers: [provideRouter([]), { provide: DiscoverService, useValue: { getPerformersFeed } }],
  }).compileComponents();
  const fixture = TestBed.createComponent(StudioPerformersComponent);
  fixture.componentInstance.studioId = 'studio-1';
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, getPerformersFeed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('StudioPerformersComponent', () => {
  it('lists the studio’s performers, searches them by name, and loads more', async () => {
    const { fixture, root, getPerformersFeed } = await render();
    await settle();
    fixture.detectChanges();
    expect(getPerformersFeed).toHaveBeenCalledWith(
      1,
      24,
      expect.objectContaining({ studioId: 'studio-1', sort: 'SCENE_COUNT' }),
    );
    expect(root.querySelector('[data-testid="studio-performer-p1"]')).not.toBeNull();

    (root.querySelector('button.more') as HTMLButtonElement).click();
    await settle();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="studio-performer-p2"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="studio-performer-p1"]')).not.toBeNull();

    const search = root.querySelector(
      '[data-testid="studio-performer-search"]',
    ) as HTMLInputElement;
    search.value = 'khloe';
    search.dispatchEvent(new Event('input'));
    await settle();
    fixture.detectChanges();
    expect(getPerformersFeed).toHaveBeenLastCalledWith(
      1,
      24,
      expect.objectContaining({ name: 'khloe', studioId: 'studio-1' }),
    );
    expect(root.querySelector('[data-testid="studio-performer-k"]')?.textContent).toContain(
      'Khloe Kingsley',
    );
    expect(root.querySelector('[data-testid="studio-performer-p1"]')).toBeNull();
  });

  it('asks for each page once, tries a failed page again, and keeps search errors visible', async () => {
    const { fixture, root, getPerformersFeed } = await render();
    await settle();
    fixture.detectChanges();
    getPerformersFeed.mockImplementationOnce(
      () => throwError(() => new Error('down')) as unknown as Observable<never>,
    );
    const more = () => (root.querySelector('button.more') as HTMLButtonElement).click();
    more();
    fixture.detectChanges();
    expect(root.textContent).toContain('Couldn’t load more');
    expect(root.querySelector('[data-testid="studio-performer-p1"]')).not.toBeNull();
    const pending = new Subject<unknown>();
    getPerformersFeed.mockImplementationOnce(() => pending as unknown as Observable<never>);
    more();
    more();
    const pages = getPerformersFeed.mock.calls.map((call) => call[0]);
    expect(pages).toEqual([1, 2, 2]);
    pending.next({
      total: 30,
      page: 2,
      perPage: 24,
      hasMore: false,
      items: [performer('p2', 'Performer 2')],
    });
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="studio-performer-p2"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="studio-performer-p1"]')).not.toBeNull();
  });

  it('starts over for another studio and doesn’t keep loading for a trailing space', async () => {
    const { fixture, root, getPerformersFeed } = await render();
    await settle();
    fixture.componentInstance.studioId = 'studio-2';
    fixture.detectChanges();
    expect(getPerformersFeed).toHaveBeenLastCalledWith(
      1,
      24,
      expect.objectContaining({ studioId: 'studio-2' }),
    );
    const search = root.querySelector(
      '[data-testid="studio-performer-search"]',
    ) as HTMLInputElement;
    // A search with no results, so "Loading…" would show if it stuck.
    getPerformersFeed.mockReturnValueOnce(
      of({ total: 0, page: 1, perPage: 24, hasMore: false, items: [] }),
    );
    search.value = 'nobody';
    search.dispatchEvent(new Event('input'));
    await settle();
    fixture.detectChanges();
    expect(root.textContent).toContain('No performer by that name');
    const calls = getPerformersFeed.mock.calls.length;
    search.value = 'nobody ';
    search.dispatchEvent(new Event('input'));
    await settle();
    fixture.detectChanges();
    expect(getPerformersFeed.mock.calls.length).toBe(calls);
    expect(root.textContent).not.toContain('Loading performers');
  });

  it('searches the same name again in the next studio, and drops a search typed for the last one', async () => {
    const { fixture, root, getPerformersFeed } = await render();
    await settle();
    const search = () =>
      root.querySelector('[data-testid="studio-performer-search"]') as HTMLInputElement;
    const type = (value: string) => {
      search().value = value;
      search().dispatchEvent(new Event('input'));
    };

    type('khloe');
    await settle();
    // Typed, then the studio changes before the pause is over.
    type('kh');
    fixture.componentInstance.studioId = 'studio-2';
    await settle();
    const studio2 = getPerformersFeed.mock.calls.filter((call) => call[2].studioId === 'studio-2');
    expect(studio2.map((call) => call[2].name)).toEqual([undefined]);

    type('khloe');
    await settle();
    expect(getPerformersFeed).toHaveBeenLastCalledWith(
      1,
      24,
      expect.objectContaining({ name: 'khloe', studioId: 'studio-2' }),
    );
  });
});
