import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
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
});
