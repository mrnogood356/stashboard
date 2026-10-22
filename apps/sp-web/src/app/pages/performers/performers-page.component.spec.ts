import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { PerformerFeedItem } from '../../core/api/discover.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { PerformersPageComponent } from './performers-page.component';

function performer(overrides: Partial<PerformerFeedItem> = {}): PerformerFeedItem {
  return {
    id: 'performer-1',
    name: 'Ana Rivers',
    gender: 'FEMALE',
    sceneCount: 12,
    isFavorite: false,
    imageUrl: null,
    cardImageUrl: null,
    ...overrides,
  };
}

const feedOf = (items: PerformerFeedItem[]) =>
  of({ total: items.length, page: 1, perPage: 24, hasMore: false, items });

describe('PerformersPageComponent', () => {
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
      getPerformersFeed: options.feed ?? vi.fn().mockReturnValue(feedOf([performer()])),
      favoritePerformer:
        options.favorite ?? vi.fn().mockReturnValue(of({ alreadyFavorited: false })),
    };
    const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [PerformersPageComponent],
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

    const fixture = TestBed.createComponent(PerformersPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, discover, notifications };
  }

  it('lists performers', async () => {
    const { root, discover } = await render();

    expect(discover.getPerformersFeed).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ favoritesOnly: false }),
    );
    expect(root.textContent).toContain('Ana Rivers');
  });

  it('reads search, gender and favorites from the address bar, ignoring unknown values', async () => {
    const { discover } = await render({ query: { q: ' ana ', gender: 'FEMALE', fav: '1' } });
    expect(discover.getPerformersFeed).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ name: 'ana', gender: 'FEMALE', favoritesOnly: true }),
    );
    TestBed.resetTestingModule();

    const bogus = await render({ query: { gender: 'NOT_A_GENDER' } });
    expect(bogus.discover.getPerformersFeed).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.not.objectContaining({ gender: 'NOT_A_GENDER' }),
    );
  });

  it('favorites a performer in place', async () => {
    const { fixture, root, discover, notifications } = await render();
    root.querySelector<HTMLButtonElement>('[aria-label="Favorite performer"]')!.click();
    fixture.detectChanges();

    expect(discover.favoritePerformer).toHaveBeenCalledWith('performer-1', true);
    expect(notifications.success).toHaveBeenCalledWith('Performer favorited');
    expect(root.querySelector('[aria-label="Unfavorite performer"]')).not.toBeNull();
  });

  it('removes an unfavorited performer from the favorites-only list', async () => {
    const feed = vi
      .fn()
      .mockReturnValueOnce(feedOf([performer({ isFavorite: true })]))
      .mockReturnValue(feedOf([]));
    const { fixture, root } = await render({ query: { fav: 'true' }, feed });
    root.querySelector<HTMLButtonElement>('[aria-label="Unfavorite performer"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(feed).toHaveBeenCalledTimes(2);
    expect(root.textContent).not.toContain('Ana Rivers');
  });

  it('says so when favoriting fails', async () => {
    const { fixture, root, notifications } = await render({
      favorite: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    root.querySelector<HTMLButtonElement>('[aria-label="Favorite performer"]')!.click();
    fixture.detectChanges();

    expect(notifications.error).toHaveBeenCalledWith('Failed to favorite performer');
  });

  it('offers a retry when the feed fails to load', async () => {
    const feed = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValue(feedOf([performer()]));
    const { fixture, root } = await render({ feed });

    root.querySelector<HTMLButtonElement>('.retry-button')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.textContent).toContain('Ana Rivers');
  });
});
