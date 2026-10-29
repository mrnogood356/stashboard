import { SETTINGS_SECTIONS } from '../../pages/settings/settings-nav';

export type QuickKind = 'page' | 'recent' | 'library' | 'performer' | 'studio' | 'catalog' | 'all';

/** One row in the search box. `url` is opened with the router. */
export interface QuickItem {
  id: string;
  kind: QuickKind;
  label: string;
  detail?: string | null;
  /** PrimeIcons class, for rows without a picture. */
  icon?: string;
  imageUrl?: string | null;
  url: string;
}

export interface QuickPage {
  label: string;
  url: string;
  icon: string;
  detail?: string;
  /** Other words people might type for it. */
  keywords?: string;
  /** Only while Settings → Playback has the feed on. */
  feed?: boolean;
}

/** Every page you can jump to, in the order they're offered. */
export const QUICK_PAGES: readonly QuickPage[] = [
  { label: 'Home', url: '/home', icon: 'pi-home' },
  { label: 'Scenes', url: '/scenes', icon: 'pi-video', keywords: 'browse catalog discover' },
  {
    label: 'Calendar',
    url: '/calendar',
    icon: 'pi-calendar',
    keywords: 'releases upcoming new schedule',
  },
  { label: 'Performers', url: '/performers', icon: 'pi-users', keywords: 'people' },
  { label: 'Studios', url: '/studios', icon: 'pi-building' },
  { label: 'Library', url: '/library', icon: 'pi-folder-open', keywords: 'stash mine owned' },
  { label: 'Requests', url: '/acquisition', icon: 'pi-inbox', keywords: 'wanted whisparr queue' },
  { label: 'Downloads', url: '/processing', icon: 'pi-sync', keywords: 'sabnzbd drop-ins' },
  { label: 'Swipe feed', url: '/feed', icon: 'pi-mobile', feed: true },
  { label: 'Search', url: '/search', icon: 'pi-search' },
  { label: 'Tools', url: '/tools', icon: 'pi-wrench' },
  {
    label: 'Fix my library',
    url: '/tools/fix',
    icon: 'pi-wrench',
    detail: 'Tools',
    keywords: 'unmatched untagged unorganized',
  },
  {
    label: 'Match & rename',
    url: '/tools/organize',
    icon: 'pi-wrench',
    detail: 'Tools',
    keywords: 'organize organise files',
  },
  { label: 'Duplicates', url: '/tools/duplicates', icon: 'pi-clone', detail: 'Tools' },
  { label: 'Samples', url: '/tools/samples', icon: 'pi-wrench', detail: 'Tools' },
  {
    label: 'Activity',
    url: '/tools/activity',
    icon: 'pi-history',
    detail: 'Tools',
    keywords: 'log history',
  },
  {
    label: 'Stash jobs',
    url: '/tools/jobs',
    icon: 'pi-cog',
    detail: 'Tools',
    keywords: 'scan generate',
  },
  { label: 'Settings', url: '/settings', icon: 'pi-cog', keywords: 'preferences options' },
  ...SETTINGS_SECTIONS.map((section) => ({
    label: section.label,
    url: section.route,
    icon: section.icon ?? 'pi-cog',
    detail: 'Settings',
    keywords: section.detail,
  })),
];

const normalize = (value: string) =>
  value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * Pages whose name (or what they're for) matches every word typed, best
 * first: names that start with it, then names that contain it, then the rest.
 */
export function matchPages(query: string, feedEnabled: boolean, limit = 5): QuickItem[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const pages = QUICK_PAGES.filter((page) => !page.feed || feedEnabled);
  if (words.length === 0) {
    return [];
  }
  return pages
    .map((page) => {
      const label = normalize(page.label);
      const all = `${label} ${normalize(page.detail ?? '')} ${normalize(page.keywords ?? '')}`;
      if (!words.every((word) => all.includes(word))) {
        return null;
      }
      const first = words[0];
      const score = label.startsWith(first) ? 0 : label.includes(first) ? 1 : 2;
      return { page, score };
    })
    .filter((hit): hit is { page: QuickPage; score: number } => hit !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ page }) => pageItem(page));
}

/** The pages offered before you type anything. */
export function startPages(feedEnabled: boolean): QuickItem[] {
  return ['/home', '/scenes', '/library', '/acquisition', '/processing', '/settings']
    .map((url) => QUICK_PAGES.find((page) => page.url === url))
    .filter((page): page is QuickPage => !!page && (!page.feed || feedEnabled))
    .map(pageItem);
}

function pageItem(page: QuickPage): QuickItem {
  return {
    id: `page:${page.url}`,
    kind: 'page',
    label: page.label,
    detail: page.detail ?? null,
    icon: page.icon,
    url: page.url,
  };
}

/** Typing in a text box shouldn't open search with "/". */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[contenteditable="true"]') !== null
  );
}
