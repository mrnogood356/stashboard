import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { LibraryService } from '../../core/api/library.service';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';
import { QuickSearchComponent } from './quick-search.component';

describe('QuickSearchComponent', () => {
  const library = {
    getScenesFeed: vi.fn(() =>
      of({
        total: 1,
        items: [
          {
            id: 'l1',
            title: 'Golden Hour',
            studio: 'Bright',
            performerNames: ['Ava'],
            imageUrl: null,
            cardImageUrl: null,
          },
        ],
      }),
    ),
  };
  const local = {
    search: vi.fn(() =>
      of({
        performers: [{ id: 'p1', name: 'Goldie', imageUrl: null, sceneCount: 2, favorite: false }],
        studios: [],
      }),
    ),
  };
  const discover = { searchScenes: vi.fn(() => throwError(() => new Error('catalog down'))) };

  async function render() {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [QuickSearchComponent],
      providers: [
        provideRouter([]),
        { provide: LibraryService, useValue: library },
        { provide: LocalLibraryService, useValue: local },
        { provide: DiscoverService, useValue: discover },
        { provide: PlaybackSettingsService, useValue: { feedEnabled: () => true } },
      ],
    });
    const fixture = TestBed.createComponent(QuickSearchComponent);
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem('stashboard.recentSearches');
  });

  const press = (key: string, init: KeyboardEventInit = {}) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));

  it('opens with Ctrl+K and with "/", and Escape closes it', async () => {
    const fixture = await render();

    press('k', { ctrlKey: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="quick-search"]')).toBeTruthy();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="quick-search"]')).toBeNull();

    press('/');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="quick-search"]')).toBeTruthy();
  });

  it('doesn’t open with "/" while you type in a box', async () => {
    const fixture = await render();
    const box = document.createElement('input');
    document.body.appendChild(box);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="quick-search"]')).toBeNull();
    box.remove();
  });

  it('shows pages, your library and people, and still works when the catalog fails', async () => {
    const fixture = await render();
    press('k', { metaKey: true });
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.value = 'gold';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);
    fixture.detectChanges();

    const labels = [...fixture.nativeElement.querySelectorAll('.row .label')].map((row: Element) =>
      row.textContent?.trim(),
    );
    expect(labels).toEqual(['Golden Hour', 'Goldie', 'See all results for “gold”']);
  });

  it('opens the highlighted row with Enter, after moving with the arrows', async () => {
    const fixture = await render();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    press('k', { ctrlKey: true });
    fixture.detectChanges();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.value = 'gold';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);
    fixture.detectChanges();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(navigate).toHaveBeenCalledWith('/library/performer/p1');
    expect(fixture.nativeElement.querySelector('[data-testid="quick-search"]')).toBeNull();
  });

  it('lists your recent searches before you type', async () => {
    localStorage.setItem('stashboard.recentSearches', JSON.stringify(['ava stone']));
    const fixture = await render();
    press('k', { ctrlKey: true });
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="quick-item-recent"]')?.textContent,
    ).toContain('ava stone');
  });
});
