/** One Settings section: a child route of /settings, shown as a card on Settings. */
export interface SettingsNavItem {
  label: string;
  route: string;
  /** PrimeIcons class for the card, e.g. 'pi-link'. */
  icon?: string;
  /** One line under the title saying what the section is for. */
  detail?: string;
  /** Which heading it sits under; none puts it under "More". */
  group?: SettingsNavGroupId;
}

export type SettingsNavGroupId = 'setup' | 'behaviour' | 'look' | 'system';

export interface SettingsNavGroup {
  id: SettingsNavGroupId | 'more';
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_NAV_GROUP_LABELS: Record<SettingsNavGroupId, string> = {
  setup: 'Setup',
  behaviour: 'Behaviour',
  look: 'Look & privacy',
  system: 'System',
};

/** Every Settings section, in order. A test checks this matches the routes. */
export const SETTINGS_SECTIONS: readonly SettingsNavItem[] = [
  {
    label: 'Integrations',
    group: 'setup',
    route: '/settings/integrations',
    icon: 'pi-link',
    detail: 'Stash, Whisparr, SABnzbd and the catalog',
  },
  {
    label: 'Indexing',
    group: 'setup',
    route: '/settings/indexing',
    icon: 'pi-sync',
    detail: 'Keep your library and the catalog in sync',
  },
  {
    label: 'Setup check',
    group: 'setup',
    route: '/settings/setup-check',
    icon: 'pi-check-circle',
    detail: 'Find anything in your setup that needs fixing',
  },
  {
    label: 'Notifications',
    group: 'behaviour',
    route: '/settings/notifications',
    icon: 'pi-bell',
    detail: 'Get told when your requests download',
  },
  {
    label: 'Automation',
    group: 'behaviour',
    route: '/settings/automation',
    icon: 'pi-bolt',
    detail: 'Get new downloads scanned, matched and ready to watch',
  },
  {
    label: 'Hidden',
    group: 'behaviour',
    route: '/settings/hidden',
    icon: 'pi-eye-slash',
    detail: 'Words, tags, studios and performers to hide everywhere',
  },
  {
    label: 'Playback',
    group: 'behaviour',
    route: '/settings/playback',
    icon: 'pi-play',
    detail: 'Turn playback, previews and the feed on or off',
  },
  {
    label: 'Appearance',
    group: 'look',
    route: '/settings/appearance',
    icon: 'pi-palette',
    detail: 'Theme, accent colour and layout',
  },
  {
    label: 'Privacy',
    group: 'look',
    route: '/settings/privacy',
    icon: 'pi-lock',
    detail: 'PIN or Face ID lock for the home-screen app',
  },
  {
    label: 'Account',
    group: 'look',
    route: '/settings/account',
    icon: 'pi-user',
    detail: 'Change your password',
  },
  {
    label: 'About & health',
    group: 'system',
    route: '/settings/about',
    icon: 'pi-info-circle',
    detail: 'Version, updates and what is working',
  },
  {
    label: 'Logs',
    group: 'system',
    route: '/settings/logs',
    icon: 'pi-list',
    detail: 'What Stashboard has been doing',
  },
];

/**
 * Groups sections in group order and then the order they were listed. A
 * section with no (or an unknown) group still shows, under "More".
 */
export function groupSettingsNav(items: readonly SettingsNavItem[]): SettingsNavGroup[] {
  const groups: SettingsNavGroup[] = (
    Object.keys(SETTINGS_NAV_GROUP_LABELS) as SettingsNavGroupId[]
  ).map((id) => ({ id, label: SETTINGS_NAV_GROUP_LABELS[id], items: [] }));
  const more: SettingsNavGroup = { id: 'more', label: 'More', items: [] };
  for (const item of items) {
    (groups.find((group) => group.id === item.group) ?? more).items.push(item);
  }
  return [...groups, more].filter((group) => group.items.length > 0);
}
