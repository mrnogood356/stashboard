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
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Scenes', 'People', 'Studios']);
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

  it('folds Downloads into Requests, without Search', async () => {
    const root = await render(REQUESTS_TABS, false);
    expect(root.querySelector('[data-testid="page-tabs-search"]')).toBeNull();
    expect(
      Array.from(root.querySelectorAll('.page-tab')).map((tab) => tab.textContent?.trim()),
    ).toEqual(['Requests', 'Downloads']);
  });
});
