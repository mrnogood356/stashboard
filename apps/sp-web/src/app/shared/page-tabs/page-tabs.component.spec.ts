import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { BROWSE_TABS, PageTabsComponent, REQUESTS_TABS } from './page-tabs.component';

describe('PageTabsComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(tabs = BROWSE_TABS, search = true) {
    await TestBed.configureTestingModule({
      imports: [PageTabsComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(PageTabsComponent);
    fixture.componentRef.setInput('title', 'Browse');
    fixture.componentRef.setInput('tabs', tabs);
    fixture.componentRef.setInput('search', search);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows Browse with Search and a link per tab', async () => {
    const root = await render();
    expect(root.querySelector('h1')?.textContent).toBe('Browse');
    expect(root.querySelector('[data-testid="page-tabs-search-input"]')).toBeTruthy();
    const tabs = Array.from(root.querySelectorAll('.page-tab'));
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Scenes', 'Performers', 'Studios']);
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
      '/scenes',
      '/performers',
      '/studios',
    ]);
  });

  it('searches the tab you are on as you type, and keeps the words across tabs', async () => {
    const root = await render();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const input = root.querySelector('[data-testid="page-tabs-search-input"]') as HTMLInputElement;
    input.value = 'golden';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ queryParams: { q: 'golden' }, replaceUrl: true }),
    );
  });

  async function renderFixture() {
    await TestBed.configureTestingModule({
      imports: [PageTabsComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(PageTabsComponent);
    fixture.componentRef.setInput('title', 'Browse');
    fixture.componentRef.setInput('tabs', BROWSE_TABS);
    fixture.componentRef.setInput('search', true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const input = root.querySelector('[data-testid="page-tabs-search-input"]') as HTMLInputElement;
    const type = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    return { fixture, root, input, type };
  }

  it('carries the words typed to the other tabs before the search runs', async () => {
    vi.useFakeTimers();
    try {
      const { root, type } = await renderFixture();
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      type('golden');
      const performers = root.querySelector('[data-testid="browse-tab-performers"]');
      expect(performers?.getAttribute('href')).toContain('q=golden');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Clear is not undone by typing that was still waiting', async () => {
    vi.useFakeTimers();
    try {
      const { root, type, fixture } = await renderFixture();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      type('golden');
      fixture.detectChanges();
      (root.querySelector('.page-tabs-search button') as HTMLButtonElement).click();
      vi.advanceTimersByTime(1000);
      // The search waiting for "golden" never runs, and the tabs carry no words.
      const searched = navigate.mock.calls.map(
        (call) => (call[1] as { queryParams: unknown }).queryParams,
      );
      expect(searched).not.toContainEqual({ q: 'golden' });
      fixture.detectChanges();
      expect(
        root.querySelector('[data-testid="browse-tab-performers"]')?.getAttribute('href'),
      ).not.toContain('q=');
    } finally {
      vi.useRealTimers();
    }
  });

  it('searches the same words again after a Clear', async () => {
    const { type } = await renderFixture();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate');
    const pause = () => new Promise((resolve) => setTimeout(resolve, 400));
    type('golden');
    await pause();
    type('');
    await pause();
    type('golden');
    await pause();
    const searched = navigate.mock.calls.map(
      (call) => (call[1] as { queryParams: unknown }).queryParams,
    );
    expect(searched).toEqual([{ q: 'golden' }, { q: null }, { q: 'golden' }]);
  });

  it('folds Downloads into Requests, without Search', async () => {
    const root = await render(REQUESTS_TABS, false);
    expect(root.querySelector('[data-testid="page-tabs-search"]')).toBeNull();
    expect(
      Array.from(root.querySelectorAll('.page-tab')).map((tab) => tab.textContent?.trim()),
    ).toEqual(['Wanted', 'Downloads']);
  });
});
