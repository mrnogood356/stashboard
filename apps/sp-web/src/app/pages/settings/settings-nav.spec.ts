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

  it('groups Settings three by three, in order, so the cards line up', () => {
    expect(
      groupSettingsNav(SETTINGS_SECTIONS).map((group) => [
        group.id,
        group.items.map((item) => item.label),
      ]),
    ).toEqual([
      ['setup', ['Integrations', 'Indexing', 'Setup check']],
      ['behaviour', ['Notifications', 'Automation', 'Hidden']],
      ['look', ['Appearance', 'Playback', 'Privacy']],
      ['system', ['Account & backup', 'About & health', 'Logs']],
    ]);
  });
});
