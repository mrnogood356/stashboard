import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS, groupSettingsNav } from './settings-nav';

describe('groupSettingsNav', () => {
  it('groups sections in group order, keeping their listed order', () => {
    const groups = groupSettingsNav([
      { label: 'Logs', route: '/settings/logs', group: 'system' },
      { label: 'Integrations', route: '/settings/integrations', group: 'setup' },
      { label: 'Appearance', route: '/settings/appearance', group: 'look' },
      { label: 'Indexing', route: '/settings/indexing', group: 'setup' },
    ]);
    expect(groups.map((group) => [group.label, group.items.map((item) => item.label)])).toEqual([
      ['Setup', ['Integrations', 'Indexing']],
      ['Look & privacy', ['Appearance']],
      ['System', ['Logs']],
    ]);
  });

  it('still shows a section added without a group, under More', () => {
    const groups = groupSettingsNav([
      { label: 'Integrations', route: '/settings/integrations', group: 'setup' },
      { label: 'Finished downloads', route: '/settings/finished' },
    ]);
    expect(groups.at(-1)).toEqual({
      id: 'more',
      label: 'More',
      items: [{ label: 'Finished downloads', route: '/settings/finished' }],
    });
  });

  it('keeps every group of Settings the same size, so the cards line up', () => {
    expect(groupSettingsNav(SETTINGS_SECTIONS).map((group) => group.items.length)).toEqual([
      3, 3, 3, 3,
    ]);
  });
});
