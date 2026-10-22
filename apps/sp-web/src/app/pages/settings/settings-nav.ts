/** One Settings section: a child route of /settings. */
export interface SettingsNavItem {
  label: string;
  route: string;
  exact?: boolean;
  /** Which heading it sits under in the section picker; none puts it under "More". */
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

/**
 * Groups sections for the picker, in group order and then the order they were
 * listed. A section with no (or an unknown) group still shows, under "More".
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
