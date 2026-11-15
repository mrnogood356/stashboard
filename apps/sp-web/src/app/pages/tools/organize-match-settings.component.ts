import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OrganizeStore } from './organize.store';

/** Match scenes → Settings: when matches are looked for, and where. */
@Component({
  selector: 'app-organize-match-settings',
  imports: [RouterLink],
  templateUrl: './organize-match-settings.component.html',
  styleUrls: [
    './tools-shared.scss',
    './organize-shared.scss',
    './organize-settings.component.scss',
  ],
})
export class OrganizeMatchSettingsComponent {
  protected readonly store = inject(OrganizeStore);
}
