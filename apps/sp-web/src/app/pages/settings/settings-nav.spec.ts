import { describe, expect, it } from 'vitest';
import { groupSettingsNav } from './settings-nav';

describe('groupSettingsNav', () => {
  it('groups sections in group order, keeping their listed order', () => {
    const groups = groupSettingsNav([
      { label: 'Logs', route: '/settings/logs', group: 'system' },
      { label: 'Overview', route: '/settings', group: 'setup' },
      { label: 'Appearance', route: '/settings/appearance', group: 'look' },
      { label: 'Indexing', route: '/settings/indexing', group: 'setup' },
    ]);
    expect(groups.map((group) => [group.label, group.items.map((item) => item.label)])).toEqual([
      ['Setup', ['Overview', 'Indexing']],
      ['Look & privacy', ['Appearance']],
      ['System', ['Logs']],
    ]);
  });

  it('still shows a section added without a group, under More', () => {
    const groups = groupSettingsNav([
      { label: 'Overview', route: '/settings', group: 'setup' },
      { label: 'Finished downloads', route: '/settings/finished' },
    ]);
    expect(groups.at(-1)).toEqual({
      id: 'more',
      label: 'More',
      items: [{ label: 'Finished downloads', route: '/settings/finished' }],
    });
  });
});
