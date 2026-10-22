import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { StudioFeedItem } from '../../core/api/discover.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { StudiosPageComponent } from './studios-page.component';

function studio(overrides: Partial<StudioFeedItem> = {}): StudioFeedItem {
  return {
    id: 'studio-1',
    name: 'Studio One',
    isFavorite: false,
    imageUrl: null,
    parentStudio: null,
    childStudios: [],
    ...overrides,
  };
}

describe('StudiosPageComponent', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  async function render(
    options: {
      query?: Record<string, string>;
      feed?: ReturnType<typeof vi.fn>;
      favorite?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const discover = {
      getStudiosFeed:
        options.feed ??
        vi.fn().mockReturnValue(
          of({
            total: 2,
            page: 1,
            perPage: 24,
            hasMore: false,
            items: [
              studio(),
              studio({
                id: 'studio-2',
                name: 'Network',
                childStudios: ['A', 'B', 'C', 'D', 'E'].map((name) => ({
                  id: name,
                  name: `Child ${name}`,
                })) as StudioFeedItem['childStudios'],
              }),
            ],
          }),
        ),
      favoriteStudio: options.favorite ?? vi.fn().mockReturnValue(of({ alreadyFavorited: false })),
    };
    const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [StudiosPageComponent],
      providers: [
        provideRouter([]),
        { provide: DiscoverService, useValue: discover },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: new BehaviorSubject(convertToParamMap(options.query ?? {})),
          },
        },
        { provide: AppNotificationsService, useValue: notifications },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(StudiosPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, discover, notifications };
  }

  it('lists studios with a preview of their child studios', async () => {
    const { root, discover } = await render();

    expect(discover.getStudiosFeed).toHaveBeenCalledWith(1, expect.any(Number), {
      name: undefined,
      sort: expect.any(String),
      direction: expect.any(String),
      favoritesOnly: false,
    });
    expect(root.textContent).toContain('Studio One');
    expect(root.textContent).toContain('Child A');
    expect(root.textContent).not.toContain('Child D');
  });

  it('reads search, sort and favorites from the address bar', async () => {
    const { discover } = await render({ query: { q: ' net ', fav: 'true' } });

    expect(discover.getStudiosFeed).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ name: 'net', favoritesOnly: true }),
    );
  });

  it('favorites a studio in place', async () => {
    const { fixture, root, discover, notifications } = await render();
    const toggle = root.querySelector<HTMLButtonElement>('[aria-label="Favorite studio"]')!;
    toggle.click();
    fixture.detectChanges();

    expect(discover.favoriteStudio).toHaveBeenCalledWith('studio-1', true);
    expect(notifications.success).toHaveBeenCalledWith('Studio favorited');
    expect(root.querySelector('[aria-label="Unfavorite studio"]')).not.toBeNull();
  });

  it('says so when favoriting fails, and leaves the studio as it was', async () => {
    const { fixture, root, notifications } = await render({
      favorite: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    root.querySelector<HTMLButtonElement>('[aria-label="Favorite studio"]')!.click();
    fixture.detectChanges();

    expect(notifications.error).toHaveBeenCalledWith('Failed to favorite studio');
    expect(root.querySelectorAll('[aria-label="Unfavorite studio"]')).toHaveLength(0);
  });

  it('offers a retry when the feed fails to load', async () => {
    const feed = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValue(of({ total: 1, page: 1, perPage: 24, hasMore: false, items: [studio()] }));
    const { fixture, root } = await render({ feed });
    const retry = root.querySelector<HTMLButtonElement>('.retry-button');
    expect(retry).not.toBeNull();

    retry!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(feed).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain('Studio One');
  });
});
