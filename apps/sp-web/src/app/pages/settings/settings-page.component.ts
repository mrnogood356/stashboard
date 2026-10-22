import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

interface SettingsNavItem {
  label: string;
  route: string;
  exact?: boolean;
}

@Component({
  selector: 'app-settings-page',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.scss',
})
export class SettingsPageComponent {
  /** On a phone the tabs scroll sideways; keep the current one in view. */
  protected onActiveChange(active: boolean, link: HTMLElement): void {
    if (!active) {
      return;
    }
    setTimeout(() => {
      const nav = link.parentElement;
      if (!nav) {
        return;
      }
      const navBox = nav.getBoundingClientRect();
      const tabBox = link.getBoundingClientRect();
      const offset = tabBox.left - navBox.left + nav.scrollLeft;
      nav.scrollTo({ left: offset - (navBox.width - tabBox.width) / 2, behavior: 'auto' });
    });
  }

  protected readonly navItems: SettingsNavItem[] = [
    {
      label: 'Overview',
      route: '/settings',
      exact: true,
    },
    {
      label: 'Integrations',
      route: '/settings/integrations',
    },
    {
      label: 'Indexing',
      route: '/settings/indexing',
    },
    {
      label: 'Notifications',
      route: '/settings/notifications',
    },
    {
      label: 'Automation',
      route: '/settings/automation',
    },
    {
      label: 'Hidden',
      route: '/settings/hidden',
    },
    {
      label: 'Setup check',
      route: '/settings/setup-check',
    },
    {
      label: 'Appearance',
      route: '/settings/appearance',
    },
    {
      label: 'Playback',
      route: '/settings/playback',
    },
    {
      label: 'Privacy',
      route: '/settings/privacy',
    },
    {
      label: 'Account',
      route: '/settings/account',
    },
    {
      label: 'About & health',
      route: '/settings/about',
    },
    {
      label: 'Logs',
      route: '/settings/logs',
    },
  ];
}
