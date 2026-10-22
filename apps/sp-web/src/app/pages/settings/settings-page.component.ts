import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SettingsNavItem } from './settings-nav';
import { SettingsSectionPickerComponent } from './settings-section-picker.component';

@Component({
  selector: 'app-settings-page',
  imports: [RouterOutlet, SettingsSectionPickerComponent],
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.scss',
})
export class SettingsPageComponent {
  /**
   * Every Settings section, in order. The section picker groups them; a new
   * section added here without a group still shows, under "More".
   */
  protected readonly navItems: SettingsNavItem[] = [
    {
      label: 'Overview',
      group: 'setup',
      route: '/settings',
      exact: true,
    },
    {
      label: 'Integrations',
      group: 'setup',
      route: '/settings/integrations',
    },
    {
      label: 'Indexing',
      group: 'setup',
      route: '/settings/indexing',
    },
    {
      label: 'Notifications',
      group: 'behaviour',
      route: '/settings/notifications',
    },
    {
      label: 'Automation',
      group: 'behaviour',
      route: '/settings/automation',
    },
    {
      label: 'Hidden',
      group: 'behaviour',
      route: '/settings/hidden',
    },
    {
      label: 'Setup check',
      group: 'setup',
      route: '/settings/setup-check',
    },
    {
      label: 'Appearance',
      group: 'look',
      route: '/settings/appearance',
    },
    {
      label: 'Playback',
      group: 'behaviour',
      route: '/settings/playback',
    },
    {
      label: 'Privacy',
      group: 'look',
      route: '/settings/privacy',
    },
    {
      label: 'Account',
      group: 'look',
      route: '/settings/account',
    },
    {
      label: 'About & health',
      group: 'system',
      route: '/settings/about',
    },
    {
      label: 'Logs',
      group: 'system',
      route: '/settings/logs',
    },
  ];
}
