import { QUICK_PAGES, isEditable, matchPages, startPages } from './quick-search.model';

describe('quick search pages', () => {
  it('finds pages by name, best match first', () => {
    expect(matchPages('dup', true).map((item) => item.label)).toEqual(['Duplicates']);
    expect(matchPages('set', true)[0].label).toBe('Settings');
    expect(matchPages('indexing', true)[0]).toMatchObject({
      label: 'Indexing',
      url: '/settings/indexing',
      detail: 'Settings',
    });
  });

  it('finds pages by what they’re for, too', () => {
    expect(matchPages('sabnzbd', true).map((item) => item.url)).toContain('/processing');
    expect(matchPages('password', true).map((item) => item.url)).toContain('/settings/account');
  });

  it('leaves the swipe feed out while it’s turned off', () => {
    expect(matchPages('swipe', false)).toEqual([]);
    expect(matchPages('swipe', true).map((item) => item.url)).toEqual(['/feed']);
  });

  it('offers the main pages before you type', () => {
    expect(startPages(true).map((item) => item.url)).toEqual([
      '/home',
      '/scenes',
      '/library',
      '/acquisition',
      '/processing',
      '/settings',
    ]);
  });

  it('only lists pages that exist, once each', () => {
    const urls = QUICK_PAGES.map((page) => page.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((url) => url.startsWith('/'))).toBe(true);
  });

  it('knows when you’re typing in a box', () => {
    expect(isEditable(document.createElement('input'))).toBe(true);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(document.createElement('button'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});
