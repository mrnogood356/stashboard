import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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
    expect(root.querySelector('[data-testid="page-tabs-search"]')?.getAttribute('href')).toBe(
      '/search',
    );
    const tabs = Array.from(root.querySelectorAll('.page-tab'));
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Scenes', 'People', 'Studios']);
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
      '/scenes',
      '/performers',
      '/studios',
    ]);
  });

  it('folds Downloads into Requests, without Search', async () => {
    const root = await render(REQUESTS_TABS, false);
    expect(root.querySelector('[data-testid="page-tabs-search"]')).toBeNull();
    expect(
      Array.from(root.querySelectorAll('.page-tab')).map((tab) => tab.textContent?.trim()),
    ).toEqual(['Requests', 'Downloads']);
  });
});
